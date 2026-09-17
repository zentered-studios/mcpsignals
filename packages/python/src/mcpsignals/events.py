"""Event dataclasses. Field names match schema/events.md exactly."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal


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
    error_kind: str | None = None
    error_message: str | None = None
    request_bytes: int = 0
    response_bytes: int = 0
    arguments: dict[str, Any] | None = None
    intent: str | None = None
    transport: str | None = None


#: What a sink receives. There is one event type today, so this is an alias
#: for `ToolCallEvent` rather than a union - it stays as the name sinks are
#: written against, and as the seam a second event type would widen.
Event = ToolCallEvent
