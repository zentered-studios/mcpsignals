from typing import Protocol, runtime_checkable

from mcpsignals.events import SessionSummaryEvent, ToolCallEvent


@runtime_checkable
class Sink(Protocol):
    """A sink accepts a batch of events, writes them, and reports failure by
    raising. It does nothing else - no retries, no local queueing beyond
    what EventBuffer already does upstream.
    """

    async def write(self, events: list[ToolCallEvent | SessionSummaryEvent]) -> None: ...
