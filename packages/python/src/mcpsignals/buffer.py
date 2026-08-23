"""Batches events and flushes to every configured sink on a size threshold
or an interval, whichever comes first. A sink failure is caught, logged at
most once per sink instance, and never propagates - a broken sink must
never break the host MCP server.
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
        flush_interval_s: float = 5.0,
    ):
        self._sinks = list(sinks)
        self._buffer_size = buffer_size
        self._flush_interval_s = flush_interval_s
        self._events: list[Event] = []
        self._lock = asyncio.Lock()
        self._warned_sinks: set[int] = set()
        self._interval_task: asyncio.Task | None = None
        atexit.register(self._atexit_flush)

    def _ensure_interval_task(self) -> None:
        # Started lazily on first event, from inside a running event loop -
        # constructing EventBuffer itself must not require a loop to exist yet.
        if self._interval_task is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._interval_task = loop.create_task(self._interval_loop())

    async def _interval_loop(self) -> None:
        while True:
            await asyncio.sleep(self._flush_interval_s)
            await self.flush()

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

        results = await asyncio.gather(
            *(self._write_to_sink(sink, batch) for sink in self._sinks),
            return_exceptions=True,
        )
        for result in results:
            if isinstance(result, Exception):
                # _write_to_sink already logged; nothing else to do here.
                pass

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
        # guaranteed flush should call `await buffer.flush()` explicitly
        # before shutting down.
        try:
            asyncio.run(self.flush())
        except RuntimeError:
            logger.warning(
                "mcpsignals: %d buffered event(s) dropped at exit (no event loop available "
                "to flush) - call `await flush()` explicitly before shutdown for a guarantee",
                len(self._events),
            )
