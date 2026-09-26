"""Core instrumentation entry point.

Built on the `mcp` v2 SDK's `middleware` list (`server.middleware.append(fn)`),
present on both `MCPServer` and the low-level `Server` - the same mechanism
works for both, no separate code paths needed. See
https://py.sdk.modelcontextprotocol.io/v2/advanced/middleware/.

`session_id`: `ServerRequestContext` - what middleware receives - has no
session id accessor (verified against mcp==2.2.0; mcp/server/context.py).
It does carry the HTTP request on the streamable HTTP path, so the
middleware reads the `Mcp-Session-Id` header the client echoes back on
every request after `initialize`. On stdio there is no transport session,
and `session_id` comes only from the optional intent-capture value the
calling agent supplies.

Guarantee: nothing the library does around a tool call can change what the
client receives. The real handler always runs, its result is returned
unchanged, and its exception propagates unchanged. Every library-side step
(request byte counting, `resolve_identity`, redaction, event construction,
`buffer.add`) is guarded: a failure is logged once per `instrument()` call on
the `mcpsignals` logger, then suppressed, and the step falls back to a
neutral value (`request_bytes` 0, identity `(None, None)`, `arguments`
None). A failing redactor therefore records `arguments=None`, never the raw
arguments. A sink failure is handled separately by EventBuffer, also logged
once per sink.
"""

import inspect
import json
import logging
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.shared.exceptions import MCPError
from pydantic import ValidationError

from mcpsignals.buffer import EventBuffer
from mcpsignals.error_kind import classify_error, is_error_kind
from mcpsignals.events import ERROR_KIND_META_KEY, ErrorKind, ResultType, ToolCallEvent
from mcpsignals.handle import InstrumentHandle
from mcpsignals.handle import register as _register_handle
from mcpsignals.intent_capture import (
    MAX_IDENTIFIER_LENGTH,
    bounded,
    enabled_for,
    inject_schema,
    strip_injected,
)
from mcpsignals.redaction import RedactionConfig, redact_arguments
from mcpsignals.sinks.base import Sink
from mcpsignals.sinks.console import ConsoleSink
from mcpsignals.trace_context import parse_traceparent

#: JSON-RPC's code for invalid params, which the SDK answers a pydantic
#: `ValidationError` with.
_INVALID_PARAMS = -32602

ToolHints = tuple[bool | None, bool | None]

logger = logging.getLogger("mcpsignals")

ResolveIdentity = Callable[
    [Any], tuple[str | None, str | None] | Awaitable[tuple[str | None, str | None]]
]


def _is_error_result(result: Any) -> bool:
    # `call_next` for `tools/call` returns a plain dict (wire-shaped, camelCase
    # keys) in mcp==2.0.0, not a CallToolResult instance - verified against the
    # installed package. Handle both shapes so this survives either.
    if isinstance(result, Mapping):
        return bool(result.get("isError", result.get("is_error", False)))
    return bool(getattr(result, "is_error", False))


def _result_content(result: Any) -> Any:
    if isinstance(result, Mapping):
        return result.get("content")
    return getattr(result, "content", None)


def _declared_error_kind(result: Any) -> ErrorKind | None:
    """The `error_kind` a handler set in the result's `_meta`, if it is a known value."""
    # Same two shapes as `_is_error_result`: wire-shaped (`_meta`) or snake_case (`meta`).
    if isinstance(result, Mapping):
        meta = result.get("_meta")
        if meta is None:
            meta = result.get("meta")
    else:
        meta = getattr(result, "meta", None)
    kind = meta.get(ERROR_KIND_META_KEY) if isinstance(meta, Mapping) else None
    return kind if is_error_kind(kind) else None


def _content_to_text(content: Any) -> str | None:
    if not content:
        return None
    parts = []
    for block in content:
        text = block.get("text") if isinstance(block, Mapping) else getattr(block, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts) if parts else None


def _result_type(result: Any) -> ResultType:
    """`input_required` for a 2026-07-28 multi-round-trip result, else `complete`."""
    if isinstance(result, Mapping):
        value = result.get("resultType", result.get("result_type"))
    else:
        value = getattr(result, "result_type", None)
    return "input_required" if value == "input_required" else "complete"


def _error_code(exc: BaseException) -> int | None:
    """The JSON-RPC code the SDK answers `exc` with, where every transport
    agrees on it. Any other exception is answered with a code that depends on
    the transport (0 or -32603), so it is recorded as None."""
    if isinstance(exc, MCPError):
        return exc.error.code
    if isinstance(exc, ValidationError):
        return _INVALID_PARAMS
    return None


def _as_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _tool_hints(tool: Any) -> tuple[str | None, ToolHints]:
    """A `tools/list` entry's name and its read-only / destructive hints.
    Handles the wire dict (camelCase) and the `Tool` model (snake_case)."""
    if isinstance(tool, Mapping):
        name = tool.get("name")
        annotations = tool.get("annotations")
    else:
        name = getattr(tool, "name", None)
        annotations = getattr(tool, "annotations", None)
    if isinstance(annotations, Mapping):
        read_only = annotations.get("readOnlyHint", annotations.get("read_only_hint"))
        destructive = annotations.get("destructiveHint", annotations.get("destructive_hint"))
    else:
        read_only = getattr(annotations, "read_only_hint", None)
        destructive = getattr(annotations, "destructive_hint", None)
    return (name if isinstance(name, str) else None), (_as_bool(read_only), _as_bool(destructive))


def _session_id_header(request: Any) -> str | None:
    """The `Mcp-Session-Id` header of an HTTP request, capped, or None."""
    headers = getattr(request, "headers", None)
    if headers is None:
        return None
    return bounded(headers.get("mcp-session-id"), MAX_IDENTIFIER_LENGTH) or None


def _serialize_for_bytes(value: Any) -> bytes:
    if value is None:
        return b""
    dump = getattr(value, "model_dump_json", None)
    if callable(dump):
        return dump().encode()
    return json.dumps(value, default=str).encode()


def instrument(
    server: Any,
    *,
    server_name: str,
    server_version: str | None = None,
    sinks: Sequence[Sink] | None = None,
    capture_arguments: bool = False,
    redaction: RedactionConfig | None = None,
    intent_capture: bool = False,
    intent_capture_tools: Mapping[str, bool] | None = None,
    resolve_identity: ResolveIdentity | None = None,
    buffer_size: int = 20,
    flush_interval_s: float | None = 5.0,
) -> Any:
    """Wrap `server` (an `MCPServer` or a low-level `Server`) so every tool
    call is recorded as a `tool_call` event, per schema/events.md. Appends
    one middleware function; call this once, right after constructing your
    server. Returns the same instance, unmodified otherwise.

    `handle_for(server)` then returns an `InstrumentHandle` with `flush()`
    and `close()`. Pass `flush_interval_s=None` for manual mode: no interval
    task and no atexit hook, so the host flushes explicitly through the
    handle (request-scoped runtimes, tests, per-request servers).
    """
    active_sinks: list[Sink] = list(sinks) if sinks else [ConsoleSink()]
    buffer = EventBuffer(active_sinks, buffer_size=buffer_size, flush_interval_s=flush_interval_s)
    _register_handle(server, InstrumentHandle(buffer))

    # Same "log once, then suppress" pattern EventBuffer uses per sink, scoped
    # to this instrument() call: one line is enough to surface a broken
    # resolver or redactor, and a line per tool call would drown the host's logs.
    warned = False

    def _warn_once(step: str, exc: BaseException) -> None:
        nonlocal warned
        if warned:
            return
        warned = True
        logger.error(
            "mcpsignals: %s failed; the tool result is unaffected and further telemetry "
            "errors from this instrument() call are suppressed: %r",
            step,
            exc,
        )

    # Tool name -> (read_only_hint, destructive_hint). Middleware sees only the
    # request, not the registration, so hints come from the `tools/list`
    # results passing through, or from `MCPServer.list_tools()` on a miss.
    tool_hints: dict[str, ToolHints] = {}

    def _remember_hints(tools: Any) -> None:
        for tool in tools or []:
            name, hints = _tool_hints(tool)
            if name is not None:
                tool_hints[name] = hints

    async def _hints_for(name: str) -> ToolHints:
        if name not in tool_hints and isinstance(server, MCPServer):
            _remember_hints(await server.list_tools())
        return tool_hints.get(name, (None, None))

    async def _mcpsignals_middleware(ctx, call_next):
        if ctx.method == "tools/list":
            result = await call_next(ctx)
            try:
                tools = (
                    result.get("tools")
                    if isinstance(result, Mapping)
                    else getattr(result, "tools", None)
                )
                _remember_hints(tools)
            except Exception as exc:  # noqa: BLE001 - never changes the tools/list result
                _warn_once("tool hints", exc)
            if intent_capture or intent_capture_tools:
                # `call_next` returns a wire-shaped dict here (camelCase keys),
                # not a ListToolsResult/Tool instance - verified against the
                # installed mcp==2.0.0 package. Handle both shapes defensively.
                if isinstance(result, Mapping):
                    for tool in result.get("tools") or []:
                        name = tool.get("name")
                        if enabled_for(
                            name, global_enabled=intent_capture, overrides=intent_capture_tools
                        ):
                            tool["inputSchema"] = inject_schema(tool.get("inputSchema"))
                else:
                    for tool in getattr(result, "tools", None) or []:
                        if enabled_for(
                            tool.name, global_enabled=intent_capture, overrides=intent_capture_tools
                        ):
                            tool.input_schema = inject_schema(tool.input_schema)
            return result

        if ctx.method != "tools/call":
            return await call_next(ctx)

        # `ts` is when the call started, not when it finished, and
        # `duration_ms` is wall time from call start to response
        # (schema/events.md): both are anchored here, before any library-side
        # step, and `_record` reads them back after the handler settles.
        #
        # Not datetime.UTC: that alias is 3.11+, and requires-python allows
        # 3.10. Ruff's UP017 would rewrite this, which is why ruff.toml pins
        # target-version to py310.
        ts = datetime.now(timezone.utc)
        start = time.perf_counter()

        params = ctx.params or {}
        # `name` comes straight off the `tools/call` request, not from the
        # registration: a client can send any string here (the call then
        # fails, but the failed event still records it), so it takes the same
        # identifier cap as the intent fields. The uncapped value still drives
        # the intent-capture lookup and the forwarded call below.
        raw_tool_name = params.get("name", "")
        tool_name = bounded(raw_tool_name, MAX_IDENTIFIER_LENGTH) or ""
        raw_arguments = params.get("arguments") or {}
        try:
            request_bytes = len(json.dumps(raw_arguments, default=str).encode())
        except Exception as exc:  # noqa: BLE001 - an unmeasurable request never blocks the handler
            _warn_once("request byte count", exc)
            request_bytes = 0

        tool_intent_enabled = enabled_for(
            raw_tool_name, global_enabled=intent_capture, overrides=intent_capture_tools
        )
        if tool_intent_enabled:
            clean_arguments, extracted = strip_injected(raw_arguments)
            forwarded_params = dict(params)
            forwarded_params["arguments"] = clean_arguments
            forward_ctx = replace(ctx, params=forwarded_params)
        else:
            clean_arguments = raw_arguments
            extracted = {"session_id": None, "agent_id": None, "intent": None}
            forward_ctx = ctx

        # The client declares its own name/version in the `initialize`
        # handshake, so both are caller-controlled and take the same
        # identifier cap as the intent fields.
        client_name: str | None = None
        client_version: str | None = None
        client_params = getattr(ctx.session, "client_params", None)
        client_info = getattr(client_params, "client_info", None) if client_params else None
        if client_info is not None:
            client_name = bounded(client_info.name, MAX_IDENTIFIER_LENGTH)
            client_version = bounded(client_info.version, MAX_IDENTIFIER_LENGTH)

        http_request = getattr(ctx, "request", None)
        transport = "http" if http_request is not None else "stdio"
        # The transport's session: the `Mcp-Session-Id` header a stateful
        # streamable HTTP client echoes back on every request. A stateless
        # server accepts any value here, so it takes the identifier cap.
        transport_session_id = _session_id_header(http_request)

        # Revision 2026-07-28 carries the version on every request's envelope;
        # earlier revisions negotiate it in `initialize`. Either way the client
        # supplied it, so it takes the identifier cap, as does the request id.
        protocol_version = bounded(getattr(ctx, "protocol_version", None), MAX_IDENTIFIER_LENGTH)
        request_id = getattr(ctx, "request_id", None)
        request_id = (
            bounded(str(request_id), MAX_IDENTIFIER_LENGTH)
            if isinstance(request_id, (str, int)) and not isinstance(request_id, bool)
            else None
        )
        meta = getattr(ctx, "meta", None)
        trace = parse_traceparent(meta.get("traceparent") if isinstance(meta, Mapping) else None)

        async def _record(ts: datetime, error: BaseException | None, result: Any) -> None:
            # First thing: the handler has just settled, so this is the
            # response time. Everything below, `resolve_identity` included,
            # is outside the timed window.
            duration_ms = int((time.perf_counter() - start) * 1000)

            # Runs after the handler so its latency never lands in
            # `duration_ms`. A host resolver that raises records a null
            # identity; the handler's result is already on its way back.
            user_id: str | None = None
            org_id: str | None = None
            if resolve_identity is not None:
                try:
                    identity = resolve_identity(ctx)
                    if inspect.isawaitable(identity):
                        identity = await identity
                    if identity:
                        user_id, org_id = identity
                except Exception as exc:  # noqa: BLE001 - a broken resolver never blocks the handler
                    _warn_once("resolve_identity", exc)
                    user_id, org_id = None, None

            # After the timed window too: on a miss this lists the server's tools.
            try:
                read_only_hint, destructive_hint = await _hints_for(raw_tool_name)
            except Exception as exc:  # noqa: BLE001 - a hint lookup never costs the event
                _warn_once("tool hints", exc)
                read_only_hint, destructive_hint = None, None

            declared_kind: ErrorKind | None = None
            result_type: ResultType | None = None
            error_code: int | None = None
            if error is not None:
                success = False
                error_message: str | None = str(error)[:2000]
                response_bytes = 0
                error_code = _error_code(error)
            else:
                result_type = _result_type(result)
                success = not _is_error_result(result)
                error_message = None if success else _content_to_text(_result_content(result))
                if error_message:
                    error_message = error_message[:2000]
                # A kind the handler declared wins; an unknown value falls back to the heuristic.
                # Guarded on its own so a throwing `_meta` costs only the
                # declared kind, not the event.
                if not success:
                    try:
                        declared_kind = _declared_error_kind(result)
                    except Exception as exc:
                        _warn_once("declared error kind", exc)
                response_bytes = len(_serialize_for_bytes(result))

            # Guarded on its own so a broken redactor still leaves an event
            # behind, recorded with `arguments=None` rather than the raw args.
            #
            # The `json.dumps` is not a formatting step, it is a proof that the
            # value survives encoding. Every sink re-serializes `arguments` on
            # its way out (`json.dumps` in postgres and bigquery,
            # `dataclasses.asdict` then `json.dumps` in the console sink), and a
            # value that cannot be encoded makes that whole `write()` raise.
            # EventBuffer catches it, so the server is never affected, but the
            # entire batch goes with it - including the unrelated events flushed
            # alongside. Proving it here costs one event's `arguments` instead of
            # a whole flush. Deliberately strict (no `default=`): it has to match
            # the least forgiving sink, not the most.
            #
            # Only a `redaction.redactor` or a `redaction.allow` entry can
            # produce such a value; the default type-only markers always encode.
            arguments = None
            if capture_arguments:
                try:
                    arguments = redact_arguments(clean_arguments, redaction)
                    json.dumps(arguments)
                except Exception as exc:  # noqa: BLE001 - never fall back to the raw arguments
                    _warn_once("redaction", exc)
                    arguments = None

            event = ToolCallEvent(
                ts=ts,
                server_name=server_name,
                server_version=server_version,
                tool_name=tool_name,
                session_id=transport_session_id or extracted.get("session_id"),
                agent_id=extracted.get("agent_id"),
                client_name=client_name,
                client_version=client_version,
                user_id=user_id,
                org_id=org_id,
                duration_ms=duration_ms,
                success=success,
                error_kind=declared_kind or classify_error(error_message),
                error_message=error_message,
                request_bytes=request_bytes,
                response_bytes=response_bytes,
                arguments=arguments,
                intent=extracted.get("intent"),
                transport=transport,
                protocol_version=protocol_version,
                request_id=request_id,
                trace_id=trace[0] if trace else None,
                parent_span_id=trace[1] if trace else None,
                result_type=result_type,
                error_code=error_code,
                read_only_hint=read_only_hint,
                destructive_hint=destructive_hint,
            )
            await buffer.add(event)

        error: BaseException | None = None
        result = None
        try:
            result = await call_next(forward_ctx)
            return result
        except BaseException as exc:
            error = exc
            raise
        finally:
            # An exception raised inside `finally` replaces the handler's
            # return value or exception, so the whole recording step is
            # guarded here. `Exception` only: a cancellation raised while
            # awaiting the resolver or the buffer must still propagate.
            try:
                await _record(ts, error, result)
            except Exception as exc:  # noqa: BLE001 - telemetry must never change the tool result
                _warn_once("event recording", exc)

    server.middleware.append(_mcpsignals_middleware)
    return server
