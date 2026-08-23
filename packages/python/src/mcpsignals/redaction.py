"""Argument redaction. Only ever invoked when argument capture is explicitly
enabled. Default behavior (capture on, no config): record keys and value
types only, never values. See the redaction section of the root README
before changing this file - it is the single most safety-critical part of
the library.
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any


def _type_marker(value: Any) -> dict[str, str]:
    if isinstance(value, bool):
        type_name = "bool"
    elif isinstance(value, list):
        type_name = "array"
    elif value is None:
        type_name = "null"
    else:
        type_name = type(value).__name__
    return {"__type": type_name}


@dataclass
class RedactionConfig:
    allow: list[str] | None = None
    deny: list[str] | None = None
    redactor: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None


def redact_arguments(args: Mapping[str, Any], config: RedactionConfig | None) -> dict[str, Any]:
    if config is not None and config.redactor is not None:
        return dict(config.redactor(args))

    # Fail-safe by design: only `allow` ever reveals a real value. A bare
    # `deny` with no `allow` does NOT imply "reveal everything else" - it
    # would be a footgun if denying one sensitive key silently leaked every
    # other field the caller didn't think to deny.
    allow = set(config.allow) if config is not None and config.allow else None
    deny = set(config.deny) if config is not None and config.deny else set()

    result: dict[str, Any] = {}
    for key, value in args.items():
        if key in deny:
            result[key] = _type_marker(value)
        elif allow is not None:
            result[key] = value if key in allow else _type_marker(value)
        else:
            # No allow/deny configured at all: keys and value types only, never values.
            result[key] = _type_marker(value)
    return result
