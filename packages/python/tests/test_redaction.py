from mcpsignals.redaction import RedactionConfig, redact_arguments


def test_default_no_config_records_types_only():
    result = redact_arguments({"query": "mugs", "limit": 10, "flag": True, "items": [1, 2]}, None)
    assert result == {
        "query": {"__type": "str"},
        "limit": {"__type": "int"},
        "flag": {"__type": "bool"},
        "items": {"__type": "array"},
    }


def test_allowlist_reveals_only_named_keys():
    config = RedactionConfig(allow=["query"])
    result = redact_arguments({"query": "mugs", "secret": "shh"}, config)
    assert result == {"query": "mugs", "secret": {"__type": "str"}}


def test_denylist_alone_does_not_unlock_real_values_elsewhere():
    # Only `allow` ever reveals a real value - a bare `deny` is purely
    # subtractive on top of the type-only default, never a signal that
    # everything else should be revealed. This is a deliberate fail-safe:
    # a user who denies one sensitive key shouldn't accidentally leak every
    # other field they didn't think to deny.
    config = RedactionConfig(deny=["secret"])
    result = redact_arguments({"query": "mugs", "secret": "shh"}, config)
    assert result == {"query": {"__type": "str"}, "secret": {"__type": "str"}}


def test_denylist_combined_with_allowlist_overrides_allow():
    config = RedactionConfig(allow=["query", "secret"], deny=["secret"])
    result = redact_arguments({"query": "mugs", "secret": "shh"}, config)
    assert result == {"query": "mugs", "secret": {"__type": "str"}}


def test_custom_redactor_used_verbatim():
    config = RedactionConfig(redactor=lambda args: {"count": len(args)})
    result = redact_arguments({"a": 1, "b": 2}, config)
    assert result == {"count": 2}


def test_none_type_marker():
    result = redact_arguments({"maybe": None}, None)
    assert result == {"maybe": {"__type": "null"}}
