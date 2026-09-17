"""Batches events and flushes to every configured sink on a size threshold
or an interval, whichever comes first. A sink failure is caught, logged at
most once per sink instance, and never propagates - a broken sink must
never break the host MCP server.

Pass `flush_interval_s=None` for manual mode: no interval task, no `atexit`
hook, the caller flushes explicitly (via `handle_for(server).flush()`).
"""

import asyncio
import atexit
import logging
from collections.abc import Sequence

from mcpsignals.events import SessionSummaryEvent, ToolCallEvent
from mcpsignals.sinks.base import Sink

logger = logging.getLogger("mcpsignals")

Event = ToolCallEvent | SessionSummaryEvent


class EventBuffer:
    def __init__(
        self,
        sinks: Sequence[Sink],
        buffer_size: int = 20,
        flush_interval_s: float | None = 5.0,
    ):
        self._sinks = list(sinks)
        self._buffer_size = buffer_size
        self._flush_interval_s = flush_interval_s
        self._events: list[Event] = []
        self._lock = asyncio.Lock()
        self._warned_sinks: set[int] = set()
        self._interval_task: asyncio.Task | None = None
        # The interval task's current flush, if one is in progress. Kept
        # outside the task (and shielded from its cancellation) so close()
        # can wait for a write that already left the buffer.
        self._inflight: asyncio.Future | None = None
        # Manual mode (`flush_interval_s=None`) never starts the interval task
        # and never registers the atexit hook. `stop()` flips this too, so a
        # later `add()` cannot silently restart the task.
        self._stopped = flush_interval_s is None
        if flush_interval_s is not None:
            atexit.register(self._atexit_flush)

    def _ensure_interval_task(self) -> None:
        # Started lazily on first event, from inside a running event loop -
        # constructing EventBuffer itself must not require a loop to exist yet.
        if self._stopped or self._interval_task is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._interval_task = loop.create_task(self._interval_loop())

    async def _interval_loop(self) -> None:
        while True:
            await asyncio.sleep(self._flush_interval_s)  # type: ignore[arg-type]
            # Shielded: cancelling this task (stop()/close()) must not abort a
            # sink write whose batch has already been popped from the buffer.
            # CancelledError is a BaseException, so _write_to_sink's `except
            # Exception` would not catch it and the batch would be lost.
            self._inflight = asyncio.ensure_future(self.flush())
            await asyncio.shield(self._inflight)

    async def add(self, event: Event) -> None:
        self._ensure_interval_task()
        async with self._lock:
            self._events.append(event)
            should_flush = len(self._events) >= self._buffer_size
        if should_flush:
            await self.flush()

    async def flush(self) -> None:
        async with self._lock:
            if not self._events:
                return
            batch, self._events = self._events, []

        # Each _write_to_sink swallows and logs its own failure, so nothing
        # here needs to inspect the results.
        await asyncio.gather(
            *(self._write_to_sink(sink, batch) for sink in self._sinks),
            return_exceptions=True,
        )

    def stop(self) -> None:
        """Cancel the interval task (if one is running) and unregister the
        atexit hook. Safe to call in manual mode, and safe to call twice.
        Does not flush, and leaves an in-flight interval write untouched:
        use `close()` for a final flush plus stop.
        """
        self._stopped = True
        if self._interval_task is not None:
            self._interval_task.cancel()
            self._interval_task = None
        # No-op when the hook was never registered (manual mode, or an
        # earlier stop() already removed it).
        atexit.unregister(self._atexit_flush)

    async def close(self) -> None:
        """`stop()`, wait for the interval task and any write it already had
        in flight to settle, then a final `flush()`. Nothing is left running
        on the loop and no popped batch is dropped. Idempotent.
        """
        task = self._interval_task
        self.stop()
        if task is not None:
            # Not `suppress(CancelledError)` around `await task`: a
            # cancellation aimed at close() itself surfaces at that same await
            # and would be swallowed too. gather(return_exceptions=True) hands
            # the interval task's own CancelledError back as a value while a
            # cancel of close() still raises out of the await. (3.10-safe:
            # `Task.cancelling()` is 3.11+.)
            await asyncio.gather(task, return_exceptions=True)
        inflight = self._inflight
        if inflight is not None and not inflight.done():
            # Shielded again so cancelling close() itself lets the write finish.
            await asyncio.shield(inflight)
        await self.flush()

    async def _write_to_sink(self, sink: Sink, batch: list[Event]) -> None:
        try:
            await sink.write(batch)
        except Exception as exc:  # noqa: BLE001 - a sink must never break the host server
            sink_id = id(sink)
            if sink_id not in self._warned_sinks:
                self._warned_sinks.add(sink_id)
                logger.error("mcpsignals: sink %r failed, dropping batch: %s", sink, exc)

    def _atexit_flush(self) -> None:
        if not self._events:
            return
        # Best-effort only: there is no guarantee a loop is available to
        # await a real flush at interpreter shutdown. Callers that need a
        # guaranteed flush should `await handle_for(server).flush()` (or
        # `.close()`) explicitly before shutting down.
        try:
            asyncio.run(self.flush())
        except RuntimeError:
            logger.warning(
                "mcpsignals: %d buffered event(s) dropped at exit (no event loop available "
                "to flush) - call `await handle_for(server).flush()` explicitly before "
                "shutdown for a guarantee",
                len(self._events),
            )
