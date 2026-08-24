"""Core instrumentation entry point.

Built on the `mcp` v2 SDK's `middleware` list (`server.middleware.append(fn)`),
present on both `MCPServer` and the low-level `Server` - the same mechanism
works for both, no separate code paths needed. See
https://py.sdk.modelcontextprotocol.io/v2/advanced/middleware/.

Known SDK limitation (verified against the installed mcp==2.0.0 source,
mcp/server/context.py): `ServerRequestContext` - what middleware receives -
does not publicly expose the transport's connection-level session id or a
`connection` accessor (only the handler-facing `Context` class does, via a
private `Connection` it doesn't share with middleware). We do not reach into
that private attribute. As a result `session_id` on emitted events is only
ever populated from the optional intent-capture value the calling agent
supplies - it is `None` for calls where intent capture is off or the caller
didn't pass one, even though the connection may well have a real session id.
Track https://github.com/modelcontextprotocol/python-sdk for this being
exposed to middleware in a future release.
"""

import inspect
import json
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any

from mcpsignals.buffer import EventBuffer
from mcpsignals.error_kind import classify_error
from mcpsignals.events import ToolCallEvent
from mcpsignals.intent_capture import enabled_for, inject_schema, strip_injected
from mcpsignals.redaction import RedactionConfig, redact_arguments
from mcpsignals.sinks.base import Sink
from mcpsignals.sinks.console import ConsoleSink

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


def _content_to_text(content: Any) -> str | None:
    if not content:
        return None
    parts = []
    for block in content:
        text = block.get("text") if isinstance(block, Mapping) else getattr(block, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts) if parts else None


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
    flush_interval_s: float = 5.0,
) -> Any:
    """Wrap `server` (an `MCPServer` or a low-level `Server`) so every tool
    call is recorded as a `tool_call` event, per schema/events.md. Appends
    one middleware function; call this once, right after constructing your
    server. Returns the same instance, unmodified otherwise.
    """
    active_sinks: list[Sink] = list(sinks) if sinks else [ConsoleSink()]
    buffer = EventBuffer(active_sinks, buffer_size=buffer_size, flush_interval_s=flush_interval_s)

    async def _mcpsignals_middleware(ctx, call_next):
        if ctx.method == "tools/list":
            result = await call_next(ctx)
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

        params = ctx.params or {}
        tool_name = params.get("name", "")
        raw_arguments = params.get("arguments") or {}
        request_bytes = len(json.dumps(raw_arguments, default=str).encode())

        tool_intent_enabled = enabled_for(
            tool_name, global_enabled=intent_capture, overrides=intent_capture_tools
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

        user_id: str | None = None
        org_id: str | None = None
        if resolve_identity is not None:
            identity = resolve_identity(ctx)
            if inspect.isawaitable(identity):
                identity = await identity
            if identity:
                user_id, org_id = identity

        client_name: str | None = None
        client_version: str | None = None
        client_params = getattr(ctx.session, "client_params", None)
        client_info = getattr(client_params, "client_info", None) if client_params else None
        if client_info is not None:
            client_name = client_info.name
            client_version = client_info.version

        transport = "http" if getattr(ctx, "request", None) is not None else "stdio"

        start = time.perf_counter()
        error: BaseException | None = None
        result = None
        try:
            result = await call_next(forward_ctx)
            return result
        except BaseException as exc:
            error = exc
            raise
        finally:
            duration_ms = int((time.perf_counter() - start) * 1000)
            if error is not None:
                success = False
                error_message: str | None = str(error)[:2000]
                response_bytes = 0
            else:
                success = not _is_error_result(result)
                error_message = None if success else _content_to_text(_result_content(result))
                if error_message:
                    error_message = error_message[:2000]
                response_bytes = len(_serialize_for_bytes(result))

            arguments = redact_arguments(clean_arguments, redaction) if capture_arguments else None

            event = ToolCallEvent(
                # Not datetime.UTC: that alias is 3.11+, and requires-python
                # allows 3.10. Ruff's UP017 would rewrite this, which is why
                # ruff.toml pins target-version to py310.
                ts=datetime.now(timezone.utc),
                server_name=server_name,
                server_version=server_version,
                tool_name=tool_name,
                session_id=extracted.get("session_id"),
                agent_id=extracted.get("agent_id"),
                client_name=client_name,
                client_version=client_version,
                user_id=user_id,
                org_id=org_id,
                duration_ms=duration_ms,
                success=success,
                error_kind=classify_error(error_message),
                error_message=error_message,
                request_bytes=request_bytes,
                response_bytes=response_bytes,
                arguments=arguments,
                intent=extracted.get("intent"),
                transport=transport,
            )
            await buffer.add(event)

    server.middleware.append(_mcpsignals_middleware)
    return server
