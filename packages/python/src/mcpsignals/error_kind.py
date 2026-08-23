"""Best-effort classification of a free-text error message into a coarse
bucket. This is NOT ground truth - `success` is. See schema/events.md for
the documented false-positive mode.
"""

import re

_NOT_FOUND = re.compile(r"not found|does not exist|no such", re.IGNORECASE)
_EMPTY = re.compile(r"\bempty\b|no results?|nothing found|zero results", re.IGNORECASE)
_VALIDATION = re.compile(r"invalid|required|expected|must be|validation|schema", re.IGNORECASE)


def classify_error(message: str | None) -> str | None:
    """Bucket an error message into not_found / empty / validation / internal.

    Returns None when there is no message to classify (i.e. the call succeeded).
    """
    if not message:
        return None
    if _NOT_FOUND.search(message):
        return "not_found"
    if _EMPTY.search(message):
        return "empty"
    if _VALIDATION.search(message):
        return "validation"
    return "internal"
