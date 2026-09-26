// Package mcpsignals records MCP tool usage into application-owned sinks.
// It supports the official github.com/modelcontextprotocol/go-sdk/mcp package.
package mcpsignals

import (
	"encoding/json"
	"regexp"
	"time"
)

// ErrorKind is a coarse failure category, not a replacement for Success.
type ErrorKind string

const (
	NotFound        ErrorKind = "not_found"
	Empty           ErrorKind = "empty"
	Validation      ErrorKind = "validation"
	AuthRequired    ErrorKind = "auth_required"
	PaymentRequired ErrorKind = "payment_required"
	Internal        ErrorKind = "internal"
	// ErrorKindMetaKey declares a category in an MCP error result's Meta map.
	ErrorKindMetaKey = "mcpsignals/error_kind"
)

// IsErrorKind reports whether value is a supported category.
func IsErrorKind(value string) bool {
	switch ErrorKind(value) {
	case NotFound, Empty, Validation, AuthRequired, PaymentRequired, Internal:
		return true
	}
	return false
}

var errorPatterns = []struct {
	pattern *regexp.Regexp
	kind    ErrorKind
}{
	{regexp.MustCompile(`(?i)not found|does not exist|no such`), NotFound},
	{regexp.MustCompile(`(?i)\bempty\b|no results?|nothing found|zero results`), Empty},
	{regexp.MustCompile(`(?i)invalid|required|expected|must be|validation|schema`), Validation},
}

// ClassifyError applies the shared schema's ordered message heuristic.
// An empty message returns "", which is represented as null in events.
// Authentication and payment categories must be explicitly declared.
func ClassifyError(message string) ErrorKind {
	if message == "" {
		return ""
	}
	for _, p := range errorPatterns {
		if p.pattern.MatchString(message) {
			return p.kind
		}
	}
	return Internal
}

// ToolCallEvent implements schema/events.md. Nullable fields have no omitempty:
// missing data is JSON null, never an absent key or an "unknown" sentinel.
// Sinks must treat events and their referenced data as read-only.
type ToolCallEvent struct {
	EventType     string          `json:"event_type"`
	TS            time.Time       `json:"ts"`
	ServerName    string          `json:"server_name"`
	ServerVersion *string         `json:"server_version"`
	ToolName      string          `json:"tool_name"`
	SessionID     *string         `json:"session_id"`
	AgentID       *string         `json:"agent_id"`
	ClientName    *string         `json:"client_name"`
	ClientVersion *string         `json:"client_version"`
	UserID        *string         `json:"user_id"`
	OrgID         *string         `json:"org_id"`
	DurationMS    int64           `json:"duration_ms"`
	Success       bool            `json:"success"`
	ErrorKind     *ErrorKind      `json:"error_kind"`
	ErrorMessage  *string         `json:"error_message"`
	RequestBytes  int             `json:"request_bytes"`
	ResponseBytes int             `json:"response_bytes"`
	Arguments     json.RawMessage `json:"arguments"`
	Intent        *string         `json:"intent"`
	Transport     *string         `json:"transport"`
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
func bounded(s string, n int) *string { return optional(truncate(s, n)) }

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
