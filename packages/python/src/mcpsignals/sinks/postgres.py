"""Postgres sink. Requires the `postgres` extra (asyncpg). Table DDL lives in
schema/events.md. Connection info comes from asyncpg's own env var defaults
(PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) or an explicit dsn/pool -
never an invented config file.
"""

from mcpsignals.events import ToolCallEvent

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
    "protocol_version",
    "request_id",
    "trace_id",
    "parent_span_id",
    "result_type",
    "error_code",
    "read_only_hint",
    "destructive_hint",
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
        if self._pool is None:
            # Local import, and only on the path that actually needs it: a
            # caller who injected their own pool never requires the `postgres`
            # extra to be installed at all.
            import asyncpg

            self._pool = await asyncpg.create_pool(dsn=self._dsn)
        return self._pool

    async def write(self, events: list[ToolCallEvent]) -> None:
        import json as _json

        tool_calls = [e for e in events if isinstance(e, ToolCallEvent)]
        if not tool_calls:
            # Nothing to write, so never open a connection (or a pool) for it.
            return

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
                        e.protocol_version,
                        e.request_id,
                        e.trace_id,
                        e.parent_span_id,
                        e.result_type,
                        e.error_code,
                        e.read_only_hint,
                        e.destructive_hint,
                    )
                    for e in tool_calls
                ]
                await conn.copy_records_to_table(
                    "mcpsignals_tool_call", records=rows, columns=_TOOL_CALL_COLUMNS
                )
