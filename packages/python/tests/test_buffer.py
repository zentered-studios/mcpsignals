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


@pytest.mark.asyncio
async def test_manual_mode_starts_no_interval_task_and_registers_no_atexit(monkeypatch):
    import mcpsignals.buffer as buffer_module

    registered: list = []
    monkeypatch.setattr(buffer_module.atexit, "register", lambda fn, *a, **k: registered.append(fn))

    sink = RecordingSink()
    buffer = EventBuffer([sink], buffer_size=100, flush_interval_s=None)
    await buffer.add(make_event("a"))

    assert buffer._interval_task is None
    assert registered == []
    assert sink.batches == []  # nothing flushes on its own in manual mode
    await buffer.flush()
    assert len(sink.batches) == 1


@pytest.mark.asyncio
async def test_interval_mode_registers_atexit_once(monkeypatch):
    import mcpsignals.buffer as buffer_module

    registered: list = []
    monkeypatch.setattr(buffer_module.atexit, "register", lambda fn, *a, **k: registered.append(fn))

    buffer = EventBuffer([RecordingSink()], buffer_size=100, flush_interval_s=999)
    assert registered == [buffer._atexit_flush]


@pytest.mark.asyncio
async def test_stop_cancels_interval_task_and_unregisters_atexit(monkeypatch):
    import mcpsignals.buffer as buffer_module

    unregistered: list = []
    monkeypatch.setattr(buffer_module.atexit, "unregister", lambda fn: unregistered.append(fn))

    buffer = EventBuffer([RecordingSink()], buffer_size=100, flush_interval_s=999)
    await buffer.add(make_event("a"))
    task = buffer._interval_task
    assert task is not None

    buffer.stop()
    await asyncio.sleep(0)
    assert task.cancelled()
    assert buffer._interval_task is None
    assert unregistered == [buffer._atexit_flush]

    # A later add() must not silently restart the interval task.
    await buffer.add(make_event("b"))
    assert buffer._interval_task is None


@pytest.mark.asyncio
async def test_stop_is_safe_in_manual_mode_and_when_called_twice():
    buffer = EventBuffer([RecordingSink()], buffer_size=100, flush_interval_s=None)
    await buffer.add(make_event("a"))
    buffer.stop()
    buffer.stop()
    assert buffer._interval_task is None


@pytest.mark.asyncio
async def test_close_flushes_then_stops():
    sink = RecordingSink()
    buffer = EventBuffer([sink], buffer_size=100, flush_interval_s=999)
    await buffer.add(make_event("a"))
    task = buffer._interval_task

    await buffer.close()
    assert len(sink.batches) == 1
    assert task is not None and task.cancelled()
    assert buffer._interval_task is None

    await buffer.close()  # idempotent
    assert len(sink.batches) == 1


@pytest.mark.asyncio
async def test_close_waits_for_in_flight_interval_flush():
    class BlockingSink:
        def __init__(self):
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.batches: list[list] = []
            self.cancelled = False

        async def write(self, events):
            self.started.set()
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
            self.batches.append(list(events))

    sink = BlockingSink()
    buffer = EventBuffer([sink], buffer_size=100, flush_interval_s=0.01)
    await buffer.add(make_event("a"))
    # The interval task has popped the batch and is inside sink.write().
    await asyncio.wait_for(sink.started.wait(), timeout=1)

    close_task = asyncio.create_task(buffer.close())
    await asyncio.sleep(0.05)
    assert not close_task.done()  # close() waits for the in-flight write
    assert sink.cancelled is False

    sink.release.set()
    await asyncio.wait_for(close_task, timeout=1)
    assert sink.cancelled is False
    assert len(sink.batches) == 1
    assert sink.batches[0][0].tool_name == "a"
    assert buffer._interval_task is None


@pytest.mark.asyncio
async def test_cancelling_close_propagates_and_skips_final_flush():
    sink = RecordingSink()
    buffer = EventBuffer([sink], buffer_size=100, flush_interval_s=999)
    await buffer.add(make_event("a"))
    assert buffer._interval_task is not None  # sleeping on the interval

    close_task = asyncio.create_task(buffer.close())
    # One loop iteration: close() has called stop() and is now suspended
    # waiting for the interval task to finish cancelling.
    await asyncio.sleep(0)
    assert not close_task.done()
    close_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await close_task
    # A cancelled close() must not go on to perform the final flush.
    assert sink.batches == []
