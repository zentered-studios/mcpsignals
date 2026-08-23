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


@dataclass
class SessionSummaryEvent:
    event_type: Literal["session_summary"] = field(init=False, default="session_summary")
    ts: datetime = field(default=None)  # type: ignore[assignment]
    session_id: str = ""
    server_name: str = ""
    server_version: str | None = None
    user_id: str | None = None
    org_id: str | None = None
    call_count: int = 0
    distinct_tools_used: int = 0
    wall_duration_ms: int = 0
    error_count: int = 0
