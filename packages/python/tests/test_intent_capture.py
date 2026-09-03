from mcpsignals.intent_capture import (
    MAX_IDENTIFIER_LENGTH,
    MAX_INTENT_LENGTH,
    inject_schema,
    strip_injected,
)


def test_strip_injected_truncates_oversized_values():
    _, extracted = strip_injected(
        {
            "query": "mugs",
            "session_id": "s" * 5000,
            "agent_id": "a" * 5000,
            "intent": "i" * 5000,
        }
    )
    assert extracted["session_id"] == "s" * MAX_IDENTIFIER_LENGTH
    assert extracted["agent_id"] == "a" * MAX_IDENTIFIER_LENGTH
    assert extracted["intent"] == "i" * MAX_INTENT_LENGTH


def test_strip_injected_leaves_values_within_the_caps_unchanged():
    _, extracted = strip_injected(
        {
            "session_id": "019609c8-1f57-7000-8000-a1b2c3d4e5f6",
            "agent_id": "agent-1",
            "intent": "i" * MAX_INTENT_LENGTH,
        }
    )
    assert extracted["session_id"] == "019609c8-1f57-7000-8000-a1b2c3d4e5f6"
    assert extracted["agent_id"] == "agent-1"
    assert len(extracted["intent"]) == MAX_INTENT_LENGTH


def test_strip_injected_discards_non_string_values():
    # A caller can send any JSON type for these keys. Anything that isn't a
    # string can't be length-bounded, so it's dropped rather than forwarded
    # into an event field typed `str | None`.
    _, extracted = strip_injected(
        {"session_id": {"nested": "object"}, "agent_id": 42, "intent": ["a", "list"]}
    )
    assert extracted == {"session_id": None, "agent_id": None, "intent": None}


def test_strip_injected_still_removes_the_keys_from_the_handler_arguments():
    clean, _ = strip_injected({"query": "mugs", "session_id": "s" * 5000, "agent_id": 42})
    assert clean == {"query": "mugs"}


def test_inject_schema_is_unaffected_by_the_caps():
    schema = inject_schema({"type": "object", "properties": {"query": {"type": "string"}}})
    assert set(schema["properties"]) == {"query", "session_id", "agent_id", "intent"}
