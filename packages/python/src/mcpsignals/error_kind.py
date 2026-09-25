"""Best-effort classification of a free-text error message into a coarse
bucket. This is NOT ground truth - `success` is. See schema/events.md for
the documented false-positive mode.
"""

import re

#: Every value `error_kind` can take. `classify_error` only produces some of
#: them; see schema/events.md.
ERROR_KINDS = (
    "not_found",
    "empty",
    "validation",
    "auth_required",
    "payment_required",
    "internal",
)

#: `_meta` key a tool handler sets on an `isError` result to record the
#: `error_kind` it already knows, instead of relying on `classify_error`.
ERROR_KIND_META_KEY = "mcpsignals/error_kind"

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
