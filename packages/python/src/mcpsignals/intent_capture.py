"""Intent capture: optionally injects session_id/agent_id/intent into the
JSON schema a tool advertises, and strips those same keys back out of the
arguments before the user's tool handler runs, so the handler receives
exactly the arguments it would have received without the library.

Off by default. See prompt spec / README for the documented tradeoff: this
adds tokens to every advertised tool schema and asks the calling model to do
extra work it may ignore or fabricate.
"""

from collections.abc import Mapping
from typing import Any

INJECTED_KEYS = ("session_id", "agent_id", "intent")

# Length caps on the caller-controlled strings that land on an event: the
# three intent-capture values the calling agent supplies here, plus
# `tool_name` (read off the `tools/call` request) and `client_name`/
# `client_version` (declared in the `initialize` handshake), which
# `instrument.py` bounds with the same `bounded()`. Without them a sink that
# batches writes in a transaction (Cloudflare D1's `batch()`, for one) loses
# every unrelated event in the flush when one oversized value fails its
# statement. Capping before the event is built rather than in each sink means
# every sink, including third-party and future ones, inherits the bound.
#
# `intent` is prose and takes the same 2000 as `error_message`. The rest are
# identifiers - a UUID is 36 chars - so they take a much tighter cap. Oversized
# values are truncated rather than dropped: losing the tail of an id is cheaper
# than losing the event.
MAX_INTENT_LENGTH = 2000
MAX_IDENTIFIER_LENGTH = 128

_MAX_LENGTHS = {
    "session_id": MAX_IDENTIFIER_LENGTH,
    "agent_id": MAX_IDENTIFIER_LENGTH,
    "intent": MAX_INTENT_LENGTH,
}

_INJECTED_PROPERTIES = {
    "session_id": {
        "type": "string",
        "description": "Opaque id grouping this call with other calls in the same task, if known.",
    },
    "agent_id": {
        "type": "string",
        "description": "Opaque id identifying which agent is making this call, if multiple agents share a session.",
    },
    "intent": {
        "type": "string",
        "description": "Why you are calling this tool.",
    },
}


def enabled_for(
    tool_name: str, *, global_enabled: bool, overrides: Mapping[str, bool] | None
) -> bool:
    if overrides is not None and tool_name in overrides:
        return overrides[tool_name]
    return global_enabled


def inject_schema(input_schema: dict[str, Any] | None) -> dict[str, Any]:
    """Return a new JSON schema with the injected properties added. Never
    mutates the input schema in place.
    """
    schema = dict(input_schema) if input_schema else {"type": "object"}
    properties = dict(schema.get("properties") or {})
    for key, spec in _INJECTED_PROPERTIES.items():
        properties.setdefault(key, spec)
    schema["properties"] = properties
    return schema


def bounded(value: Any, max_length: int) -> str | None:
    """Return `value` cut to `max_length` characters, or None for a non-string.

    A caller can send any JSON type for these keys. Anything that isn't a
    string can't be length-bounded, so it's dropped rather than forwarded
    into an event field typed `str | None`. Python slices by code point, so
    the cut never lands inside a character.
    """
    if not isinstance(value, str):
        return None
    return value[:max_length]


def strip_injected(
    arguments: Mapping[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, str | None]]:
    """Split raw arguments into (clean_arguments, extracted) where
    `extracted` holds session_id/agent_id/intent (None if absent, non-string
    or length-bounded per `_MAX_LENGTHS`) and `clean_arguments` has those
    three keys removed - exactly what the handler would have received without
    the library.
    """
    args = dict(arguments) if arguments else {}
    extracted = {key: bounded(args.pop(key, None), _MAX_LENGTHS[key]) for key in INJECTED_KEYS}
    return args, extracted
