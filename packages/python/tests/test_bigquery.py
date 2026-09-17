import json
from datetime import datetime, timezone

import pytest
from mcpsignals.events import ToolCallEvent
from mcpsignals.sinks.bigquery import BigQuerySink

TS = datetime(2026, 9, 1, 23, 25, 24, tzinfo=timezone.utc)


class FakeClient:
    """Records insert_rows_json(table_ref, rows) calls. Returns `errors` (an
    empty list means success, matching google-cloud-bigquery's contract)."""

    def __init__(self, errors=None):
        self.calls: list[tuple[str, list[dict]]] = []
        self.errors = errors if errors is not None else []

    def insert_rows_json(self, table_ref, rows):
        self.calls.append((table_ref, rows))
        return self.errors


def make_tool_call(**overrides) -> ToolCallEvent:
    defaults = dict(ts=TS, server_name="s", tool_name="my-tool", duration_ms=5)
    defaults.update(overrides)
    return ToolCallEvent(**defaults)


async def test_tool_call_rows_go_to_the_tool_call_table():
    client = FakeClient()
    sink = BigQuerySink(dataset="d", client=client)

    await sink.write([make_tool_call()])

    assert [table_ref for table_ref, _ in client.calls] == ["d.tool_call"]
    assert len(client.calls[0][1]) == 1


async def test_arguments_are_sent_as_a_json_string_for_the_json_column():
    # tabledata.insertAll expects a JSON-typed column as a JSON string, which
    # is what google-cloud-bigquery's own insert_rows() does for JSON fields
    # (_helpers._json_to_json). insert_rows_json applies no conversion, so the
    # sink has to encode the dict itself.
    client = FakeClient()
    sink = BigQuerySink(dataset="d", client=client)
    event = make_tool_call(arguments={"a": 1, "nested": {"b": [1, 2]}})

    await sink.write([event])

    row = client.calls[0][1][0]
    assert isinstance(row["arguments"], str)
    assert row["arguments"] == json.dumps(event.arguments)


async def test_null_arguments_stay_null():
    client = FakeClient()
    sink = BigQuerySink(dataset="d", client=client)

    await sink.write([make_tool_call(arguments=None)])

    assert client.calls[0][1][0]["arguments"] is None


async def test_ts_is_iso_formatted_and_event_type_is_dropped():
    client = FakeClient()
    sink = BigQuerySink(dataset="d", client=client)

    await sink.write([make_tool_call()])

    row = client.calls[0][1][0]
    assert row["ts"] == "2026-09-01T23:25:24+00:00"
    assert "event_type" not in row


async def test_a_batch_makes_one_insert_for_the_whole_batch():
    client = FakeClient()
    sink = BigQuerySink(dataset="d", client=client)

    await sink.write([make_tool_call(), make_tool_call(tool_name="other")])

    assert [table_ref for table_ref, _ in client.calls] == ["d.tool_call"]
    assert len(client.calls[0][1]) == 2


async def test_empty_batch_never_calls_the_client():
    client = FakeClient()
    sink = BigQuerySink(dataset="d", client=client)

    await sink.write([])

    assert client.calls == []


async def test_insert_errors_raise():
    client = FakeClient(errors=[{"index": 0, "errors": [{"reason": "invalid"}]}])
    sink = BigQuerySink(dataset="d", client=client)

    with pytest.raises(RuntimeError, match="d.tool_call"):
        await sink.write([make_tool_call()])
