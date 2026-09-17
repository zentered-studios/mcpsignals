"""Tests for the Postgres sink.

The sink builds its rows as positional tuples and hands them to
`copy_records_to_table` alongside a separate `columns` list. Nothing in the
type system ties the two together, so a column added to one and not the
other, or added in a different position, silently writes every value into
the wrong column. `test_tool_call_record_is_aligned_with_its_column_list`
below is the guard for that: it checks each column against the field of the
same name rather than against a hand-written expected tuple, so it keeps
working when a column is legitimately added.
"""

import importlib.util
import json
from datetime import datetime, timezone

import pytest
from mcpsignals.events import SessionSummaryEvent, ToolCallEvent
from mcpsignals.sinks.postgres import (
    _SESSION_SUMMARY_COLUMNS,
    _TOOL_CALL_COLUMNS,
    PostgresSink,
)

TS = datetime(2026, 9, 1, 23, 25, 24, tzinfo=timezone.utc)


class FakeConnection:
    def __init__(self):
        self.calls: list[dict] = []

    async def copy_records_to_table(self, table, *, records, columns):
        self.calls.append({"table": table, "records": list(records), "columns": list(columns)})


class _Acquire:
    """Mimics asyncpg's `pool.acquire()`, which is used as an async context
    manager rather than awaited.
    """

    def __init__(self, pool):
        self._pool = pool

    async def __aenter__(self):
        self._pool.acquired += 1
        return self._pool.conn

    async def __aexit__(self, *exc_info):
        return False


class FakePool:
    def __init__(self):
        self.conn = FakeConnection()
        self.acquired = 0

    def acquire(self):
        return _Acquire(self)


def make_tool_call(**overrides) -> ToolCallEvent:
    """Every field carries a distinct, recognizable value so a column that
    reads the wrong position cannot coincidentally match.
    """
    defaults = dict(
        ts=TS,
        server_name="server-name-value",
        server_version="server-version-value",
        tool_name="tool-name-value",
        session_id="session-id-value",
        agent_id="agent-id-value",
        client_name="client-name-value",
        client_version="client-version-value",
        user_id="user-id-value",
        org_id="org-id-value",
        duration_ms=11,
        success=True,
        error_kind="not_found",
        error_message="error-message-value",
        request_bytes=22,
        response_bytes=33,
        arguments=None,
        intent="intent-value",
        transport="http",
    )
    defaults.update(overrides)
    return ToolCallEvent(**defaults)


def make_session_summary(**overrides) -> SessionSummaryEvent:
    defaults = dict(
        ts=TS,
        session_id="session-id-value",
        server_name="server-name-value",
        server_version="server-version-value",
        user_id="user-id-value",
        org_id="org-id-value",
        call_count=44,
        distinct_tools_used=55,
        wall_duration_ms=66,
        error_count=77,
    )
    defaults.update(overrides)
    return SessionSummaryEvent(**defaults)


@pytest.mark.asyncio
async def test_tool_call_rows_go_to_the_tool_call_table():
    pool = FakePool()

    await PostgresSink(pool=pool).write([make_tool_call(), make_tool_call(tool_name="other")])

    assert len(pool.conn.calls) == 1, "one COPY per table per flush, not one per event"
    call = pool.conn.calls[0]
    assert call["table"] == "mcpsignals_tool_call"
    assert call["columns"] == _TOOL_CALL_COLUMNS
    assert len(call["records"]) == 2


@pytest.mark.asyncio
async def test_tool_call_record_is_aligned_with_its_column_list():
    pool = FakePool()
    event = make_tool_call()

    await PostgresSink(pool=pool).write([event])

    call = pool.conn.calls[0]
    record = call["records"][0]
    assert len(record) == len(_TOOL_CALL_COLUMNS), "one value per declared column"

    for column, value in zip(_TOOL_CALL_COLUMNS, record, strict=True):
        if column == "arguments":
            continue  # JSON-encoded on the way out, checked separately
        assert value == getattr(event, column), f"column {column!r} carries the wrong field"


@pytest.mark.asyncio
async def test_session_summary_record_is_aligned_with_its_column_list():
    pool = FakePool()
    event = make_session_summary()

    await PostgresSink(pool=pool).write([event])

    call = pool.conn.calls[0]
    assert call["table"] == "mcpsignals_session_summary"
    assert call["columns"] == _SESSION_SUMMARY_COLUMNS

    record = call["records"][0]
    assert len(record) == len(_SESSION_SUMMARY_COLUMNS)
    for column, value in zip(_SESSION_SUMMARY_COLUMNS, record, strict=True):
        assert value == getattr(event, column), f"column {column!r} carries the wrong field"


@pytest.mark.asyncio
async def test_arguments_are_json_encoded_and_none_stays_none():
    pool = FakePool()
    args = {"a": 1, "nested": {"b": "c"}}
    index = _TOOL_CALL_COLUMNS.index("arguments")

    await PostgresSink(pool=pool).write(
        [make_tool_call(arguments=args), make_tool_call(arguments=None)]
    )

    records = pool.conn.calls[0]["records"]
    assert json.loads(records[0][index]) == args
    assert records[1][index] is None, "a null must stay null, not become the string 'null'"


@pytest.mark.asyncio
async def test_mixed_batch_writes_one_copy_per_table():
    pool = FakePool()

    await PostgresSink(pool=pool).write(
        [
            make_tool_call(),
            make_session_summary(session_id="a"),
            make_tool_call(tool_name="other"),
            make_session_summary(session_id="b"),
        ]
    )

    assert [call["table"] for call in pool.conn.calls] == [
        "mcpsignals_tool_call",
        "mcpsignals_session_summary",
    ]
    assert len(pool.conn.calls[0]["records"]) == 2
    assert len(pool.conn.calls[1]["records"]) == 2


@pytest.mark.asyncio
async def test_empty_batch_never_touches_the_pool():
    pool = FakePool()

    await PostgresSink(pool=pool).write([])

    assert pool.conn.calls == []


@pytest.mark.asyncio
async def test_injected_pool_does_not_require_asyncpg_to_be_installed():
    """A caller who hands the sink a pool they already manage should not need
    the `postgres` extra at all. The Node sink returns an injected pool before
    it ever imports `pg`; this one imported `asyncpg` unconditionally first.

    asyncpg is deliberately absent from the dev environment, so this test is
    only meaningful while that holds - hence the skip rather than a silent pass.
    """
    if importlib.util.find_spec("asyncpg") is not None:
        pytest.skip("asyncpg is installed, so this cannot prove the import is skipped")

    pool = FakePool()
    await PostgresSink(pool=pool).write([make_tool_call()])

    assert len(pool.conn.calls) == 1
