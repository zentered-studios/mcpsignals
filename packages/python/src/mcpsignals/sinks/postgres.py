"""Postgres sink. Requires the `postgres` extra (asyncpg). Table DDL lives in
schema/events.md. Connection info comes from asyncpg's own env var defaults
(PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) or an explicit dsn/pool -
never an invented config file.
"""

from mcpsignals.events import SessionSummaryEvent, ToolCallEvent

_TOOL_CALL_COLUMNS = [
    "ts",
    "server_name",
    "server_version",
    "tool_name",
    "session_id",
    "agent_id",
    "client_name",
    "client_version",
    "user_id",
    "org_id",
    "duration_ms",
    "success",
    "error_kind",
    "error_message",
    "request_bytes",
    "response_bytes",
    "arguments",
    "intent",
    "transport",
]

_SESSION_SUMMARY_COLUMNS = [
    "ts",
    "session_id",
    "server_name",
    "server_version",
    "user_id",
    "org_id",
    "call_count",
    "distinct_tools_used",
    "wall_duration_ms",
    "error_count",
]


class PostgresSink:
    def __init__(self, dsn: str | None = None, pool=None):
        """Provide either `dsn` (asyncpg will connect lazily) or an existing
        `pool` (an asyncpg.Pool you already manage). If neither is given,
        asyncpg's own environment-variable defaults apply.
        """
        self._dsn = dsn
        self._pool = pool

    async def _get_pool(self):
        import asyncpg  # local import: don't require asyncpg unless this sink is used

        if self._pool is None:
            self._pool = await asyncpg.create_pool(dsn=self._dsn)
        return self._pool

    async def write(self, events: list[ToolCallEvent | SessionSummaryEvent]) -> None:
        import json as _json

        tool_calls = [e for e in events if isinstance(e, ToolCallEvent)]
        summaries = [e for e in events if isinstance(e, SessionSummaryEvent)]

        pool = await self._get_pool()
        async with pool.acquire() as conn:
            if tool_calls:
                rows = [
                    (
                        e.ts,
                        e.server_name,
                        e.server_version,
                        e.tool_name,
                        e.session_id,
                        e.agent_id,
                        e.client_name,
                        e.client_version,
                        e.user_id,
                        e.org_id,
                        e.duration_ms,
                        e.success,
                        e.error_kind,
                        e.error_message,
                        e.request_bytes,
                        e.response_bytes,
                        _json.dumps(e.arguments) if e.arguments is not None else None,
                        e.intent,
                        e.transport,
                    )
                    for e in tool_calls
                ]
                await conn.copy_records_to_table(
                    "mcpsignals_tool_call", records=rows, columns=_TOOL_CALL_COLUMNS
                )
            if summaries:
                rows = [
                    (
                        e.ts,
                        e.session_id,
                        e.server_name,
                        e.server_version,
                        e.user_id,
                        e.org_id,
                        e.call_count,
                        e.distinct_tools_used,
                        e.wall_duration_ms,
                        e.error_count,
                    )
                    for e in summaries
                ]
                await conn.copy_records_to_table(
                    "mcpsignals_session_summary", records=rows, columns=_SESSION_SUMMARY_COLUMNS
                )
