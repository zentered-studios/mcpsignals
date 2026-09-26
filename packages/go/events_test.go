package mcpsignals

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestEventContract(t *testing.T) {
	e := ToolCallEvent{EventType: "tool_call", TS: time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC), ServerName: "test", ToolName: "echo", Success: true}
	raw, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	fields := strings.Fields("event_type ts server_name server_version tool_name session_id agent_id client_name client_version user_id org_id duration_ms success error_kind error_message request_bytes response_bytes arguments intent transport")
	if len(got) != len(fields) {
		t.Fatalf("unexpected fields: %s", raw)
	}
	for _, k := range fields {
		if _, ok := got[k]; !ok {
			t.Errorf("missing %s", k)
		}
	}
	for _, k := range strings.Fields("server_version session_id agent_id client_name client_version user_id org_id error_kind error_message arguments intent transport") {
		if got[k] != nil {
			t.Errorf("%s must be null: %v", k, got[k])
		}
	}
	for _, k := range strings.Fields("duration_ms request_bytes response_bytes") {
		if got[k] != float64(0) {
			t.Errorf("%s must be a number: %v", k, got[k])
		}
	}
	if got["success"] != true || got["ts"] != "2026-09-26T12:00:00Z" || got["event_type"] != "tool_call" {
		t.Fatal(string(raw))
	}
}

func TestRedaction(t *testing.T) {
	raw := json.RawMessage(`{"s":"secret","n":9007199254740993,"b":true,"o":{"secret":"value"},"a":[1],"z":null}`)
	if got := captureArguments(raw, false, Redaction{}); got != nil {
		t.Fatal(string(got))
	}
	got := captureArguments(raw, true, Redaction{})
	var types map[string]map[string]string
	if err := json.Unmarshal(got, &types); err != nil {
		t.Fatal(err)
	}
	for key, kind := range map[string]string{"s": "string", "n": "number", "b": "boolean", "o": "object", "a": "array", "z": "null"} {
		if types[key]["__type"] != kind {
			t.Fatalf("%s: %s", key, got)
		}
	}
	got = captureArguments(raw, true, Redaction{Allow: []string{"s", "n"}, Deny: []string{"s"}})
	if strings.Contains(string(got), "secret") || !strings.Contains(string(got), "9007199254740993") {
		t.Fatal(string(got))
	}
	for name, r := range map[string]Redaction{
		"error": {Redactor: func(map[string]any) (map[string]any, error) {
			return map[string]any{"secret": "leak"}, errors.New("failed")
		}},
		"panic":       {Redactor: func(map[string]any) (map[string]any, error) { panic("secret") }},
		"unencodable": {Redactor: func(map[string]any) (map[string]any, error) { return map[string]any{"bad": make(chan int)}, nil }},
	} {
		t.Run(name, func(t *testing.T) {
			if got := captureArguments(raw, true, r); got != nil {
				t.Fatal(string(got))
			}
		})
	}
	got = captureArguments(raw, true, Redaction{Deny: []string{"custom"}, Redactor: func(a map[string]any) (map[string]any, error) { return map[string]any{"custom": "override"}, nil }})
	if string(got) != `{"custom":"override"}` {
		t.Fatal(string(got))
	}
	if !reflect.DeepEqual(raw, json.RawMessage(`{"s":"secret","n":9007199254740993,"b":true,"o":{"secret":"value"},"a":[1],"z":null}`)) {
		t.Fatal("mutated input")
	}
	for _, bad := range []string{`[]`, `{`, `{} x`} {
		if captureArguments(json.RawMessage(bad), true, Redaction{}) != nil {
			t.Fatal(bad)
		}
	}
	for _, empty := range []string{``, `null`} {
		if got := captureArguments(json.RawMessage(empty), true, Redaction{}); string(got) != `{}` {
			t.Fatalf("%q: %s", empty, got)
		}
	}
}

func TestErrorClassificationAndBounds(t *testing.T) {
	for message, want := range map[string]ErrorKind{"not found": "not_found", "no results": "empty", "invalid schema": "validation", "Login required.": "validation", "boom": "internal"} {
		if got := ClassifyError(message); got != want {
			t.Errorf("%q: %s", message, got)
		}
	}
	if ClassifyError("") != "" {
		t.Fatal("empty message must have null kind")
	}
	for _, kind := range []ErrorKind{NotFound, Empty, Validation, AuthRequired, PaymentRequired, Internal} {
		if !IsErrorKind(string(kind)) {
			t.Fatal(kind)
		}
	}
	if IsErrorKind("unknown") {
		t.Fatal("accepted unknown kind")
	}
	if got := bounded(strings.Repeat("界", 200), 128); len([]rune(*got)) != 128 {
		t.Fatal("incorrect Unicode bound")
	}
	for _, tc := range []struct{ in, want string }{{"abc", "abc"}, {"abcd", "abc"}, {"界界界", "界界界"}, {"a界bc", "a界b"}} {
		if got := truncate(tc.in, 3); got != tc.want {
			t.Fatalf("truncate(%q) = %q", tc.in, got)
		}
	}
	big := strings.Repeat("界", 1<<20)
	if allocs := testing.AllocsPerRun(5, func() { _ = truncate(big, 2000) }); allocs != 0 {
		t.Fatalf("truncate allocated %v times", allocs)
	}
	if bounded("", 128) != nil {
		t.Fatal("empty string must be null")
	}
}
