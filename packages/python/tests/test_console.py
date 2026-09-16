import io
import json
from datetime import UTC, datetime

from mcpsignals.events import ToolCallEvent
from mcpsignals.sinks import ConsoleSink


def make_event(tool_name="t") -> ToolCallEvent:
    return ToolCallEvent(
        tool_name=tool_name,
        server_name="s",
        ts=datetime(2026, 9, 16, 12, 0, 0, tzinfo=UTC),
    )


async def test_writes_to_sys_stdout_by_default(capsys):
    await ConsoleSink().write([make_event("a")])

    captured = capsys.readouterr()
    assert captured.err == ""
    assert json.loads(captured.out)["tool_name"] == "a"


async def test_writes_to_the_configured_stream_and_not_to_stdout(capsys):
    stream = io.StringIO()

    await ConsoleSink(stream=stream).write([make_event("a")])

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
    assert json.loads(stream.getvalue())["tool_name"] == "a"


async def test_emits_one_json_line_per_event_with_iso_ts():
    stream = io.StringIO()

    await ConsoleSink(stream=stream).write([make_event("a"), make_event("b"), make_event("c")])

    lines = stream.getvalue().split("\n")
    assert lines[-1] == ""  # every line is newline-terminated
    lines = lines[:-1]
    assert len(lines) == 3
    for line, expected in zip(lines, ["a", "b", "c"], strict=True):
        parsed = json.loads(line)
        assert parsed["event_type"] == "tool_call"
        assert parsed["tool_name"] == expected
        assert parsed["ts"] == "2026-09-16T12:00:00+00:00"
