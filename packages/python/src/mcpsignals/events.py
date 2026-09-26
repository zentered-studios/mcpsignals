"""Event dataclasses. Field names match schema/events.md exactly."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, get_args

#: Every value `error_kind` can take. `classify_error` only produces some of
#: them; see schema/events.md.
ErrorKind = Literal[
    "not_found",
    "empty",
    "validation",
    "auth_required",
    "payment_required",
    "internal",
]
ERROR_KINDS: tuple[ErrorKind, ...] = get_args(ErrorKind)

#: A `tools/call` result's `resultType` (protocol revision 2026-07-28).
#: Older revisions only ever produce `complete`.
ResultType = Literal["complete", "input_required"]

#: `_meta` key a tool handler sets on an `isError` result to record the
#: `error_kind` it already knows, instead of relying on `classify_error`.
ERROR_KIND_META_KEY = "mcpsignals/error_kind"


@dataclass
class ToolCallEvent:
    event_type: Literal["tool_call"] = field(init=False, default="tool_call")
    ts: datetime = field(default=None)  # type: ignore[assignment]
    server_name: str = ""
    server_version: str | None = None
    tool_name: str = ""
    session_id: str | None = None
    agent_id: str | None = None
    client_name: str | None = None
    client_version: str | None = None
    user_id: str | None = None
    org_id: str | None = None
    duration_ms: int = 0
    success: bool = True
    error_kind: ErrorKind | None = None
    error_message: str | None = None
    request_bytes: int = 0
    response_bytes: int = 0
    arguments: dict[str, Any] | None = None
    intent: str | None = None
    transport: str | None = None
    protocol_version: str | None = None
    request_id: str | None = None
    trace_id: str | None = None
    parent_span_id: str | None = None
    result_type: ResultType | None = None
    error_code: int | None = None
    read_only_hint: bool | None = None
    destructive_hint: bool | None = None


#: What a sink receives. There is one event type today, so this is an alias
#: for `ToolCallEvent` rather than a union - it stays as the name sinks are
#: written against, and as the seam a second event type would widen.
Event = ToolCallEvent
