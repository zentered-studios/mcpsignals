import asyncio

import pytest

from mcpsignals.buffer import EventBuffer
from mcpsignals.events import ToolCallEvent


def make_event(tool_name="t") -> ToolCallEvent:
    return ToolCallEvent(tool_name=tool_name, server_name="s")


class RecordingSink:
    def __init__(self):
        self.batches: list[list] = []

    async def write(self, events):
        self.batches.append(list(events))


class FailingSink:
    def __init__(self):
        self.calls = 0

    async def write(self, events):
        self.calls += 1
        raise RuntimeError("sink is down")


@pytest.mark.asyncio
async def test_flushes_on_size_threshold():
    sink = RecordingSink()
    buffer = EventBuffer([sink], buffer_size=2, flush_interval_s=999)

    await buffer.add(make_event("a"))
    assert sink.batches == []  # below threshold, not flushed yet
    await buffer.add(make_event("b"))
    assert len(sink.batches) == 1
    assert len(sink.batches[0]) == 2


@pytest.mark.asyncio
async def test_explicit_flush_sends_partial_batch():
    sink = RecordingSink()
    buffer = EventBuffer([sink], buffer_size=100, flush_interval_s=999)

    await buffer.add(make_event("a"))
    await buffer.flush()
    assert len(sink.batches) == 1
    assert len(sink.batches[0]) == 1


@pytest.mark.asyncio
async def test_flushes_on_interval():
    sink = RecordingSink()
    buffer = EventBuffer([sink], buffer_size=100, flush_interval_s=0.05)

    await buffer.add(make_event("a"))
    await asyncio.sleep(0.15)
    assert len(sink.batches) == 1


@pytest.mark.asyncio
async def test_sink_failure_is_swallowed_and_does_not_raise():
    sink = FailingSink()
    buffer = EventBuffer([sink], buffer_size=1, flush_interval_s=999)

    # Must not raise, even though the sink always raises.
    await buffer.add(make_event("a"))
    assert sink.calls == 1


@pytest.mark.asyncio
async def test_one_sink_failing_does_not_block_another():
    good = RecordingSink()
    bad = FailingSink()
    buffer = EventBuffer([bad, good], buffer_size=1, flush_interval_s=999)

    await buffer.add(make_event("a"))
    assert bad.calls == 1
    assert len(good.batches) == 1
