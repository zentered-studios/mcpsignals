"""W3C trace context parsing. Mirrors packages/node/src/trace-context.ts."""

import re
from typing import Any

_TRACEPARENT = re.compile(r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}(-.*)?$")


def parse_traceparent(value: Any) -> tuple[str, str] | None:
    """The `(trace_id, parent_span_id)` of a W3C `traceparent`, or None when
    the value is not a valid one. MCP carries it unprefixed in a request's
    `_meta` (the spec's named exception to the `_meta` key-prefix rule).

    The client controls this value, so anything that is not exactly the
    format is dropped rather than recorded: a version of `ff`, an all-zero
    id, or a version-00 header with trailing fields. A higher version may
    append fields; only the first four are read, as the W3C spec requires.
    """
    if not isinstance(value, str):
        return None
    match = _TRACEPARENT.fullmatch(value)
    if match is None:
        return None
    version, trace_id, parent_span_id, rest = match.groups()
    if version == "ff" or (version == "00" and rest is not None):
        return None
    if set(trace_id) == {"0"} or set(parent_span_id) == {"0"}:
        return None
    return trace_id, parent_span_id
