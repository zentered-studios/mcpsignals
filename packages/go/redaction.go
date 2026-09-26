package mcpsignals

import (
	"bytes"
	"encoding/json"
	"slices"
)

// Redaction controls top-level argument capture. Deny wins over Allow.
// Redactor overrides both lists and receives a detached JSON object, with
// numbers as json.Number. Errors, panics and unencodable output fail closed.
// Callbacks run on the request goroutine and must be concurrency-safe and fast.
type Redaction struct {
	Allow    []string
	Deny     []string
	Redactor func(map[string]any) (map[string]any, error)
}

func captureArguments(raw json.RawMessage, enabled bool, config Redaction) (out json.RawMessage) {
	if !enabled {
		return nil
	}
	defer func() {
		if recover() != nil {
			out = nil
		}
	}()
	var args map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if !json.Valid(raw) || dec.Decode(&args) != nil || args == nil {
		return nil
	}
	if config.Redactor != nil {
		result, err := config.Redactor(args)
		if err != nil || result == nil {
			return nil
		}
		args = result
	} else {
		for key, value := range args {
			if slices.Contains(config.Allow, key) && !slices.Contains(config.Deny, key) {
				continue
			}
			kind := "null"
			switch value.(type) {
			case string:
				kind = "string"
			case json.Number:
				kind = "number"
			case bool:
				kind = "boolean"
			case []any:
				kind = "array"
			case map[string]any:
				kind = "object"
			}
			args[key] = map[string]string{"__type": kind}
		}
	}
	encoded, err := json.Marshal(args)
	if err != nil {
		return nil
	}
	return encoded
}
