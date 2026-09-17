import dataclasses
import json
import sys
from typing import TextIO

from mcpsignals.events import ToolCallEvent


class ConsoleSink:
    """The default sink. Zero configuration, writes one JSON line per event
    to stdout so the library is useful without setting up a warehouse.

    `stream` picks where the lines go. `None` (the default) resolves to
    `sys.stdout` at write time, so output redirection and test capture that
    replace `sys.stdout` still apply. On a stdio transport, stdout is the MCP
    wire: the spec says the server MUST NOT write anything to stdout that is
    not a valid MCP message, and MAY log to stderr. Pass `sys.stderr` there.
    """

    def __init__(self, stream: TextIO | None = None) -> None:
        self._stream = stream

    async def write(self, events: list[ToolCallEvent]) -> None:
        stream = self._stream if self._stream is not None else sys.stdout
        for event in events:
            payload = dataclasses.asdict(event)
            payload["ts"] = event.ts.isoformat() if event.ts else None
            print(json.dumps(payload, default=str), file=stream, flush=True)
