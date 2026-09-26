package mcpsignals

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

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
	// Transport may be "stdio" or "http" when the application knows the transport.
	// Otherwise HTTP is detected from RequestExtra.Header; other transports are null.
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
// Call once per server, after other receiving middleware, before serving clients.
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
		event := h.prepare(ctx, call)
		start := time.Now()
		event.TS = start.UTC()
		// Deliberately no recovery around next: handler errors/panics belong to the SDK.
		result, err := next(ctx, method, req)
		event.DurationMS = time.Since(start).Milliseconds()
		h.record(event, result, err)
		return result, err
	}
}

func (h *Handle) prepare(ctx context.Context, req *mcp.CallToolRequest) (e ToolCallEvent) {
	e = ToolCallEvent{EventType: "tool_call", ServerName: h.options.ServerName, ServerVersion: optional(h.options.ServerVersion), ToolName: truncate(req.Params.Name, 128), RequestBytes: len(req.Params.Arguments)}
	// Telemetry never changes the invocation, even if SDK metadata access fails.
	defer func() { _ = recover() }()
	e.Arguments = captureArguments(req.Params.Arguments, h.options.CaptureArguments, h.options.Redaction)
	c := CallContext{Transport: h.options.Transport}
	if req.Extra != nil && req.Extra.Header != nil {
		c.Transport = "http"
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
	identity := resolveIdentity(ctx, h.options.ResolveIdentity, c)
	e.UserID = optional(identity.UserID)
	e.OrgID = optional(identity.OrgID)
	return e
}

func resolveIdentity(ctx context.Context, f func(context.Context, CallContext) (Identity, error), c CallContext) (identity Identity) {
	defer func() {
		if recover() != nil {
			identity = Identity{}
		}
	}()
	if f != nil {
		value, err := f(ctx, c)
		if err == nil {
			return value
		}
	}
	return Identity{}
}

func (h *Handle) record(e ToolCallEvent, result mcp.Result, callErr error) {
	defer func() { _ = recover() }()
	e.Success = callErr == nil
	var message string
	var declared string
	if callErr != nil {
		message = safeErrorMessage(callErr)
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
		e.ErrorMessage = bounded(message, 2000)
		kind := ClassifyError(valueOrEmpty(e.ErrorMessage))
		if IsErrorKind(declared) {
			kind = ErrorKind(declared)
		}
		if kind != "" {
			e.ErrorKind = &kind
		}
	}
	h.buffer.Push(e)
}

func valueOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
func safeErrorMessage(err error) (message string) {
	defer func() { _ = recover() }()
	return err.Error()
}
func serializedSize(v any) (size int) {
	defer func() { _ = recover() }()
	data, err := json.Marshal(v)
	if err == nil {
		return len(data)
	}
	return 0
}
