package mcpsignals

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Identity is supplied only by the application. Empty fields become null.
type Identity struct {
	UserID string
	OrgID  string
}

// CallContext contains detached metadata for an application identity resolver.
// No user identity is inferred from client metadata, arguments or headers.
type CallContext struct {
	SessionID     string
	ClientName    string
	ClientVersion string
	Transport     string
	// TokenInfo is this request's verified bearer token, set by the SDK's
	// auth.RequireBearerToken on streamable HTTP. Nil otherwise. Read-only.
	TokenInfo *auth.TokenInfo
	// Header is a copy of this request's HTTP headers, nil for other transports.
	Header http.Header
}

// Options configures instrumentation. Supply the same name/version passed to
// mcp.NewServer: the SDK does not expose the server's Implementation publicly.
// Configure once, before connecting clients. Callbacks must be concurrency-safe.
type Options struct {
	ServerName       string
	ServerVersion    string
	Buffer           BufferOptions
	CaptureArguments bool
	Redaction        Redaction
	ResolveIdentity  func(context.Context, CallContext) (Identity, error)
	// Transport is "stdio", "http", or empty. A request with HTTP headers
	// (streamable HTTP) always records "http". Otherwise this value is used, and
	// empty means "stdio", as in Node/Python. Set "http" for the legacy SSE
	// transport, which exposes no headers to middleware.
	Transport string
}

// Handle owns the telemetry lifecycle, not the MCP server or its sinks.
type Handle struct {
	Server  *mcp.Server
	buffer  *EventBuffer
	options Options
}

// Instrument adds supported receiving middleware without changing tool handlers
// or registration APIs. Existing and subsequently registered tools are observed.
// Call once per server, before serving clients. Middleware added earlier runs
// inside this one, so ResolveIdentity cannot see context values it adds.
func Instrument(server *mcp.Server, o Options) (*Handle, error) {
	if server == nil || o.ServerName == "" {
		return nil, errors.New("mcpsignals: server and server name are required")
	}
	if o.Transport != "" && o.Transport != "stdio" && o.Transport != "http" {
		return nil, errors.New("mcpsignals: transport must be stdio, http, or empty")
	}
	o.Redaction.Allow = append([]string(nil), o.Redaction.Allow...)
	o.Redaction.Deny = append([]string(nil), o.Redaction.Deny...)
	b, err := NewEventBuffer(o.Buffer)
	if err != nil {
		return nil, err
	}
	h := &Handle{Server: server, buffer: b, options: o}
	server.AddReceivingMiddleware(h.middleware)
	return h, nil
}

// Flush waits for previously started writes and flushes queued events.
func (h *Handle) Flush(ctx context.Context) error { return h.buffer.Flush(ctx) }

// Close drains telemetry after the application has stopped and drained requests.
func (h *Handle) Close(ctx context.Context) error { return h.buffer.Close(ctx) }

// Stats returns buffer overflow and sink failure counters.
func (h *Handle) Stats() BufferStats { return h.buffer.Stats() }

func (h *Handle) middleware(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		call, ok := req.(*mcp.CallToolRequest)
		if method != "tools/call" || !ok || call == nil || call.Params == nil {
			return next(ctx, method, req)
		}
		start := time.Now()
		// A handler may replace Params fields; record what the call arrived with.
		name, args := call.Params.Name, call.Params.Arguments
		// Deliberately no recovery around next: handler errors/panics belong to the SDK.
		result, err := next(ctx, method, req)
		duration := time.Since(start)
		if r, ok := result.(*mcp.CallToolResult); ok && r != nil && r.NeedsInput() {
			// Not a completed invocation: the client answers the input requests
			// and retries, and that continuation is recorded.
			return result, err
		}
		// Identity and redaction run after the handler, as in Node/Python, so a
		// slow resolver neither delays the handler nor shifts ts.
		event := h.prepare(ctx, call, name, args)
		event.TS = start.UTC()
		event.DurationMS = durationMS(duration)
		h.record(event, result, err)
		return result, err
	}
}

func (h *Handle) prepare(ctx context.Context, req *mcp.CallToolRequest, name string, args json.RawMessage) (e ToolCallEvent) {
	e = ToolCallEvent{EventType: "tool_call", ServerName: h.options.ServerName, ServerVersion: optional(h.options.ServerVersion), ToolName: truncate(name, 128), RequestBytes: len(args)}
	// Telemetry never changes the invocation, even if SDK metadata access fails.
	defer func() { _ = recover() }()
	e.Arguments = captureArguments(args, h.options.CaptureArguments, h.options.Redaction)
	c := CallContext{Transport: h.options.Transport}
	if req.Extra != nil {
		c.TokenInfo = req.Extra.TokenInfo
		if req.Extra.Header != nil {
			c.Transport = "http"
			if h.options.ResolveIdentity != nil {
				c.Header = req.Extra.Header.Clone()
			}
		}
	}
	if c.Transport == "" {
		c.Transport = "stdio"
	}
	if req.Session != nil {
		c.SessionID = req.Session.ID()
	}
	if info := req.ClientInfo(); info != nil {
		c.ClientName = info.Name
		c.ClientVersion = info.Version
	}
	e.Transport = optional(c.Transport)
	e.SessionID = optional(c.SessionID)
	e.ClientName = bounded(c.ClientName, 128)
	e.ClientVersion = bounded(c.ClientVersion, 128)
	// A resolver error or panic leaves user_id and org_id null.
	if h.options.ResolveIdentity != nil {
		if identity, err := h.options.ResolveIdentity(ctx, c); err == nil {
			e.UserID = optional(identity.UserID)
			e.OrgID = optional(identity.OrgID)
		}
	}
	return e
}

func (h *Handle) record(e ToolCallEvent, result mcp.Result, callErr error) {
	setOutcome(&e, result, callErr)
	h.buffer.Push(e)
}

// setOutcome fills the outcome fields. A panic keeps the fields set so far,
// so the call is still recorded.
func setOutcome(e *ToolCallEvent, result mcp.Result, callErr error) {
	defer func() { _ = recover() }()
	e.Success = callErr == nil
	var message string
	var declared string
	if callErr != nil {
		message = callErr.Error()
	} else if r, ok := result.(*mcp.CallToolResult); ok && r != nil {
		e.ResponseBytes = serializedSize(r)
		e.Success = !r.IsError
		if r.IsError {
			var parts []string
			for _, content := range r.Content {
				if text, ok := content.(*mcp.TextContent); ok && text != nil {
					parts = append(parts, text.Text)
				}
			}
			message = strings.Join(parts, " ")
			switch value := r.Meta[ErrorKindMetaKey].(type) {
			case string:
				declared = value
			case ErrorKind:
				declared = string(value)
			}
		}
	}
	if !e.Success {
		message = truncate(message, 2000)
		e.ErrorMessage = optional(message)
		kind := ClassifyError(message)
		if IsErrorKind(declared) {
			kind = ErrorKind(declared)
		}
		if kind != "" {
			e.ErrorKind = &kind
		}
	}
}

// durationMS rounds to the nearest millisecond, like Node's Math.round, so
// rows from every package agree for sub-millisecond calls.
func durationMS(d time.Duration) int64 { return d.Round(time.Millisecond).Milliseconds() }

func serializedSize(v any) (size int) {
	defer func() { _ = recover() }()
	data, err := json.Marshal(v)
	if err == nil {
		return len(data)
	}
	return 0
}
