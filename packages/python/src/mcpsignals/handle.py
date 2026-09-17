"""The host's way to reach the buffer behind an instrumented server.

`instrument()` keeps returning the server object unchanged (so existing
callers are not affected); the handle is looked up separately through
`handle_for(server)`. The registry is a `weakref.WeakKeyDictionary` keyed
by the exact server object passed to `instrument()`: the handle lives
exactly as long as that server object does and is dropped with it, so a
per-request server does not leak its buffer.
"""

import weakref
from typing import Any

from mcpsignals.buffer import EventBuffer


class InstrumentHandle:
    """Returned by `handle_for(server)` for a server that went through
    `instrument()`. `flush()` delivers everything buffered so far to every
    sink; `close()` does a final flush, cancels the interval task, and
    unregisters the atexit hook. Both are safe to await more than once.
    """

    def __init__(self, buffer: EventBuffer):
        self._buffer = buffer

    async def flush(self) -> None:
        """Flush buffered events to every sink now. On a request-scoped
        runtime, or in manual mode (`flush_interval_s=None`), call this
        before returning the response.
        """
        await self._buffer.flush()

    async def close(self) -> None:
        """Final flush, then stop: cancel the interval task if one is
        running and unregister the atexit hook. Call this when the server
        is done for good - at the end of a test, or when a per-request
        server is discarded. Idempotent.
        """
        await self._buffer.close()


_registry: weakref.WeakKeyDictionary[Any, InstrumentHandle] = weakref.WeakKeyDictionary()


def register(server: Any, handle: InstrumentHandle) -> None:
    _registry[server] = handle


def handle_for(server: Any) -> InstrumentHandle | None:
    """The `InstrumentHandle` for `server`, or `None` if that exact object
    never went through `instrument()`.
    """
    try:
        return _registry.get(server)
    except TypeError:
        # Not hashable or not weakly referenceable: cannot have been registered.
        return None
