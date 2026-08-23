from mcpsignals.error_kind import classify_error


def test_none_message_returns_none():
    assert classify_error(None) is None


def test_empty_string_returns_none():
    assert classify_error("") is None


def test_not_found_bucket():
    assert classify_error("widget 'abc' not found") == "not_found"
    assert classify_error("resource does not exist") == "not_found"
    assert classify_error("no such file or directory") == "not_found"


def test_empty_bucket():
    assert classify_error("query returned no results") == "empty"
    assert classify_error("the result set was empty") == "empty"


def test_validation_bucket():
    assert classify_error("invalid argument: query") == "validation"
    assert classify_error("query is required") == "validation"
    assert classify_error("expected a string") == "validation"


def test_internal_default_bucket():
    assert classify_error("connection reset by peer") == "internal"


def test_known_false_positive_documented_in_schema():
    # An internal failure whose message happens to contain "not found" text
    # buckets as not_found even though nothing the caller asked for was
    # missing - documented in schema/events.md, asserted here so the
    # behavior doesn't silently drift.
    assert classify_error("config key 'timeout' not found in environment") == "not_found"


def test_check_order_not_found_wins_over_validation():
    assert classify_error("invalid id: record not found") == "not_found"
