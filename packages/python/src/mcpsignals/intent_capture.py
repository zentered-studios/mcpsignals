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


def enabled_for(tool_name: str, *, global_enabled: bool, overrides: Mapping[str, bool] | None) -> bool:
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


def strip_injected(arguments: Mapping[str, Any] | None) -> tuple[dict[str, Any], dict[str, str | None]]:
    """Split raw arguments into (clean_arguments, extracted) where
    `extracted` holds session_id/agent_id/intent (None if absent) and
    `clean_arguments` has those three keys removed - exactly what the
    handler would have received without the library.
    """
    args = dict(arguments) if arguments else {}
    extracted = {key: args.pop(key, None) for key in INJECTED_KEYS}
    return args, extracted
