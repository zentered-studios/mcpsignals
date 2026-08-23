import dataclasses
import json
import sys

from mcpsignals.events import SessionSummaryEvent, ToolCallEvent


class ConsoleSink:
    """The default sink. Zero configuration, writes one JSON line per event
    to stdout so the library is useful without setting up a warehouse.
    """

    async def write(self, events: list[ToolCallEvent | SessionSummaryEvent]) -> None:
        for event in events:
            payload = dataclasses.asdict(event)
            payload["ts"] = event.ts.isoformat() if event.ts else None
            print(json.dumps(payload, default=str), file=sys.stdout, flush=True)
