package mcpsignals

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func connect(t *testing.T, s *mcp.Server, protocol string) *mcp.ClientSession {
	t.Helper()
	a, b := mcp.NewInMemoryTransports()
	ctx := context.Background()
	ss, err := s.Connect(ctx, a, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ss.Close() })
	c := mcp.NewClient(&mcp.Implementation{Name: strings.Repeat("c", 150), Version: "1.2"}, nil)
	cs, err := c.Connect(ctx, b, &mcp.ClientSessionOptions{ProtocolVersion: protocol})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}
func instrumentTest(t *testing.T, s *mcp.Server, o Options) (*Handle, *memorySink) {
	t.Helper()
	sink := new(memorySink)
	o.ServerName = "test-server"
	o.ServerVersion = "1.0"
	o.Buffer.Manual = true
	o.Buffer.Sinks = append(o.Buffer.Sinks, sink)
	h, err := Instrument(s, o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close(context.Background()) })
	return h, sink
}
func addRaw(s *mcp.Server, name string, h mcp.ToolHandler) {
	s.AddTool(&mcp.Tool{Name: name, InputSchema: map[string]any{"type": "object"}}, h)
}

func TestSDKToolCalls(t *testing.T) {
	for _, protocol := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(protocol, func(t *testing.T) {
			s := mcp.NewServer(&mcp.Implementation{Name: "test-server", Version: "1.0"}, nil)
			addRaw(s, "echo", func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(req.Params.Arguments)}}}, nil
			})
			// Instruments tools registered before and after instrumentation.
			h, sink := instrumentTest(t, s, Options{})
			addRaw(s, "denied", func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				return &mcp.CallToolResult{IsError: true, Meta: mcp.Meta{ErrorKindMetaKey: "auth_required"}, Content: []mcp.Content{&mcp.TextContent{Text: "Sign in."}}}, nil
			})
			addRaw(s, "fault", func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				return nil, errors.New("storage unavailable")
			})
			type input struct {
				Name string `json:"name"`
			}
			mcp.AddTool(s, &mcp.Tool{Name: "typed"}, func(_ context.Context, _ *mcp.CallToolRequest, in input) (*mcp.CallToolResult, any, error) {
				return nil, nil, fmt.Errorf("not found: %s", in.Name)
			})
			cs := connect(t, s, protocol)
			args := json.RawMessage(`{"secret":"秘密"}`)
			result, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "echo", Arguments: args})
			if err != nil {
				t.Fatal(err)
			}
			if result.IsError || result.Content[0].(*mcp.TextContent).Text != string(args) {
				t.Fatal(result)
			}
			result, err = cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "denied", Arguments: map[string]any{}})
			if err != nil || !result.IsError || result.Meta[ErrorKindMetaKey] != "auth_required" {
				t.Fatalf("%+v %v", result, err)
			}
			for _, name := range []string{"fault", "missing"} {
				if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name}); err == nil {
					t.Fatalf("%s error lost", name)
				}
			}
			for _, arg := range []any{map[string]any{"name": "missing"}, map[string]any{"name": 42}} {
				res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "typed", Arguments: arg})
				if err != nil || !res.IsError {
					t.Fatalf("%+v %v", res, err)
				}
			}
			if err := h.Flush(context.Background()); err != nil {
				t.Fatal(err)
			}
			events := sink.snapshot()
			if len(events) != 6 {
				t.Fatalf("events: %d", len(events))
			}
			e := events[0]
			if e.ServerName != "test-server" || *e.ServerVersion != "1.0" || e.ToolName != "echo" || !e.Success || e.Arguments != nil || e.ErrorKind != nil || e.ErrorMessage != nil || e.Transport == nil || *e.Transport != "stdio" || e.SessionID != nil || e.UserID != nil || len(*e.ClientName) != 128 || *e.ClientVersion != "1.2" || e.RequestBytes != len(args) || e.ResponseBytes == 0 || e.DurationMS < 0 || e.TS.Location() != time.UTC {
				t.Fatalf("bad event: %+v", e)
			}
			if *events[1].ErrorKind != AuthRequired || *events[1].ErrorMessage != "Sign in." {
				t.Fatalf("bad tool error: %+v", events[1])
			}
			if events[2].Success || events[2].ResponseBytes != 0 || *events[2].ErrorKind != Internal {
				t.Fatal(events[2])
			}
			if events[3].Success || events[3].ResponseBytes != 0 {
				t.Fatal(events[3])
			}
			if *events[4].ErrorKind != NotFound || *events[5].ErrorKind != Internal {
				t.Fatalf("typed: %s %q; validation: %s %q", *events[4].ErrorKind, *events[4].ErrorMessage, *events[5].ErrorKind, *events[5].ErrorMessage)
			}
		})
	}
}

func TestSDKConcurrentCallsAndTelemetryFailures(t *testing.T) {
	s := mcp.NewServer(&mcp.Implementation{Name: "test-server"}, nil)
	addRaw(s, "echo", func(_ context.Context, r *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(r.Params.Arguments)}}}, nil
	})
	h, sink := instrumentTest(t, s, Options{CaptureArguments: true, Redaction: Redaction{Redactor: func(map[string]any) (map[string]any, error) { panic("private data") }}, ResolveIdentity: func(context.Context, CallContext) (Identity, error) { panic("private identity") }, Buffer: BufferOptions{Sinks: []Sink{sinkFunc(func(context.Context, []ToolCallEvent) error { panic("offline") })}}})
	cs := connect(t, s, "")
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Go(func() {
			res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "echo", Arguments: map[string]any{"secret": "unchanged"}})
			if err != nil {
				t.Error(err)
				return
			}
			if res.Content[0].(*mcp.TextContent).Text != `{"secret":"unchanged"}` {
				t.Error(res)
			}
		})
	}
	wg.Wait()
	if err := h.Flush(context.Background()); err == nil {
		t.Fatal("sink failure hidden")
	}
	events := sink.snapshot()
	if len(events) != 50 {
		t.Fatal(len(events))
	}
	for _, e := range events {
		if !e.Success || e.Arguments != nil || e.UserID != nil || e.OrgID != nil {
			t.Fatal(e)
		}
	}
}

func TestSDKCancellation(t *testing.T) {
	s := mcp.NewServer(&mcp.Implementation{Name: "test-server"}, nil)
	started, observed := make(chan struct{}), make(chan struct{})
	addRaw(s, "wait", func(ctx context.Context, _ *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		close(started)
		<-ctx.Done()
		close(observed)
		return nil, ctx.Err()
	})
	written := make(chan ToolCallEvent, 1)
	h, _ := instrumentTest(t, s, Options{Buffer: BufferOptions{Sinks: []Sink{sinkFunc(func(_ context.Context, e []ToolCallEvent) error {
		for _, v := range e {
			written <- v
		}
		return nil
	})}}})
	cs := connect(t, s, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "wait"}); done <- err }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("handler not started")
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	select {
	case <-observed:
	case <-time.After(time.Second):
		t.Fatal("handler did not observe cancellation")
	}
	// Server Close waits for handler/middleware completion; client cancellation alone does not.
	if err := cs.Close(); err != nil {
		t.Fatal(err)
	}
	// Poll via explicit flush because cancellation replies need not await server-side recording.
	deadline := time.After(time.Second)
	for {
		if err := h.Flush(context.Background()); err != nil {
			t.Fatal(err)
		}
		select {
		case e := <-written:
			if e.Success || e.ResponseBytes != 0 {
				t.Fatal(e)
			}
			return
		case <-deadline:
			t.Fatal("canceled call not recorded")
		default:
			time.Sleep(time.Millisecond)
		}
	}
}

func TestSDKHTTPMetadata(t *testing.T) {
	for _, protocol := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(protocol, func(t *testing.T) {
			s := mcp.NewServer(&mcp.Implementation{Name: "test-server"}, nil)
			h, sink := instrumentTest(t, s, Options{ResolveIdentity: func(_ context.Context, c CallContext) (Identity, error) {
				if c.Transport != "http" {
					return Identity{}, errors.New("wrong transport")
				}
				return Identity{UserID: "host-user", OrgID: "host-org"}, nil
			}})
			addRaw(s, "ok", func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				return &mcp.CallToolResult{}, nil
			})
			httpServer := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, &mcp.StreamableHTTPOptions{Stateless: protocol == "2026-07-28"}))
			defer httpServer.Close()
			client := mcp.NewClient(&mcp.Implementation{Name: "http-client", Version: "1"}, nil)
			cs, err := client.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: httpServer.URL}, &mcp.ClientSessionOptions{ProtocolVersion: protocol})
			if err != nil {
				t.Fatal(err)
			}
			defer cs.Close()
			if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "ok"}); err != nil {
				t.Fatal(err)
			}
			if err := h.Flush(context.Background()); err != nil {
				t.Fatal(err)
			}
			e := sink.snapshot()[0]
			if *e.Transport != "http" || *e.ClientName != "http-client" || *e.UserID != "host-user" || *e.OrgID != "host-org" {
				t.Fatal(e)
			}
			if protocol == "2025-11-25" && e.SessionID == nil {
				t.Fatal("legacy HTTP session missing")
			}
			if protocol == "2026-07-28" && e.SessionID != nil {
				t.Fatal("invented stateless session")
			}
		})
	}
}

type headerTransport struct{ header http.Header }

func (t headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	for k, v := range t.header {
		r.Header[k] = v
	}
	return http.DefaultTransport.RoundTrip(r)
}

func TestSDKBearerTokenReachesResolver(t *testing.T) {
	s := mcp.NewServer(&mcp.Implementation{Name: "test-server"}, nil)
	h, sink := instrumentTest(t, s, Options{ResolveIdentity: func(_ context.Context, c CallContext) (Identity, error) {
		if c.TokenInfo == nil {
			return Identity{}, errors.New("no token")
		}
		return Identity{UserID: c.TokenInfo.UserID, OrgID: c.Header.Get("X-Org")}, nil
	}})
	addRaw(s, "ok", func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{}, nil
	})
	verify := func(_ context.Context, token string, _ *http.Request) (*auth.TokenInfo, error) {
		return &auth.TokenInfo{UserID: "user-" + token, Expiration: time.Now().Add(time.Hour)}, nil
	}
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, nil)
	httpServer := httptest.NewServer(auth.RequireBearerToken(verify, nil)(handler))
	defer httpServer.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "http-client", Version: "1"}, nil)
	httpClient := &http.Client{Transport: headerTransport{http.Header{"Authorization": {"Bearer abc"}, "X-Org": {"org-1"}}}}
	cs, err := client.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: httpServer.URL, HTTPClient: httpClient}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "ok"}); err != nil {
		t.Fatal(err)
	}
	if err := h.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	e := sink.snapshot()[0]
	if e.UserID == nil || *e.UserID != "user-abc" || e.OrgID == nil || *e.OrgID != "org-1" {
		t.Fatal(e)
	}
}

func TestSlowResolverDoesNotDelayHandlerOrTimestamp(t *testing.T) {
	sink := new(memorySink)
	b := newBuffer(t, BufferOptions{Manual: true, Sinks: []Sink{sink}})
	h := &Handle{buffer: b, options: Options{ServerName: "test", ResolveIdentity: func(context.Context, CallContext) (Identity, error) {
		time.Sleep(50 * time.Millisecond)
		return Identity{UserID: "u"}, nil
	}}}
	req := &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Name: "test"}}
	entered := time.Now()
	var handlerStart time.Time
	next := func(context.Context, string, mcp.Request) (mcp.Result, error) {
		handlerStart = time.Now()
		return &mcp.CallToolResult{}, nil
	}
	if _, err := h.middleware(next)(context.Background(), "tools/call", req); err != nil {
		t.Fatal(err)
	}
	if err := h.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	e := sink.snapshot()[0]
	if handlerStart.Sub(entered) > 25*time.Millisecond || e.TS.Sub(entered) > 25*time.Millisecond || e.UserID == nil {
		t.Fatalf("resolver ran before handler: handler +%v, ts +%v", handlerStart.Sub(entered), e.TS.Sub(entered))
	}
}

type userKey struct{}

func TestResolverSeesContextFromMiddlewareAddedLater(t *testing.T) {
	s := mcp.NewServer(&mcp.Implementation{Name: "test-server"}, nil)
	h, sink := instrumentTest(t, s, Options{ResolveIdentity: func(ctx context.Context, _ CallContext) (Identity, error) {
		user, _ := ctx.Value(userKey{}).(string)
		return Identity{UserID: user}, nil
	}})
	s.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			return next(context.WithValue(ctx, userKey{}, "auth-user"), method, req)
		}
	})
	addRaw(s, "ok", func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{}, nil
	})
	if _, err := connect(t, s, "").CallTool(context.Background(), &mcp.CallToolParams{Name: "ok"}); err != nil {
		t.Fatal(err)
	}
	if err := h.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e := sink.snapshot()[0]; e.UserID == nil || *e.UserID != "auth-user" {
		t.Fatal(e)
	}
}

func TestMiddlewareTransport(t *testing.T) {
	for _, tc := range []struct {
		configured string
		header     http.Header
		want       string
	}{
		{"", nil, "stdio"},
		{"http", nil, "http"},
		{"stdio", http.Header{}, "http"},
	} {
		sink := new(memorySink)
		b := newBuffer(t, BufferOptions{Manual: true, Sinks: []Sink{sink}})
		h := &Handle{buffer: b, options: Options{ServerName: "test", Transport: tc.configured}}
		req := &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Name: "test"}}
		if tc.header != nil {
			req.Extra = &mcp.RequestExtra{Header: tc.header}
		}
		ok := func(context.Context, string, mcp.Request) (mcp.Result, error) { return &mcp.CallToolResult{}, nil }
		if _, err := h.middleware(ok)(context.Background(), "tools/call", req); err != nil {
			t.Fatal(err)
		}
		if err := h.Flush(context.Background()); err != nil {
			t.Fatal(err)
		}
		if got := sink.snapshot()[0].Transport; got == nil || *got != tc.want {
			t.Fatalf("configured %q: got %v, want %s", tc.configured, got, tc.want)
		}
	}
}

func TestMiddlewarePreservesPointersContextAndPanics(t *testing.T) {
	b := newBuffer(t, BufferOptions{Manual: true})
	h := &Handle{buffer: b, options: Options{ServerName: "test"}}
	ctx := context.WithValue(context.Background(), struct{}{}, "same")
	req := &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Name: "test", Arguments: json.RawMessage(`{}`)}}
	result := &mcp.CallToolResult{}
	sentinel := errors.New("sentinel")
	next := func(c context.Context, m string, r mcp.Request) (mcp.Result, error) {
		if c != ctx || r != req || m != "tools/call" {
			t.Fatal("changed handler inputs")
		}
		return result, sentinel
	}
	got, err := h.middleware(next)(ctx, "tools/call", req)
	if got != result || err != sentinel {
		t.Fatal("changed handler outcome")
	}
	defer func() {
		if recover() != sentinel {
			t.Fatal("handler panic changed")
		}
	}()
	_, _ = h.middleware(func(context.Context, string, mcp.Request) (mcp.Result, error) { panic(sentinel) })(ctx, "tools/call", req)
}

func TestSDKSlowSinkDoesNotDelayResponse(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	s := mcp.NewServer(&mcp.Implementation{Name: "test"}, nil)
	addRaw(s, "ok", func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{}, nil
	})
	h, err := Instrument(s, Options{ServerName: "test", Buffer: BufferOptions{BufferSize: 1, Sinks: []Sink{sinkFunc(func(context.Context, []ToolCallEvent) error { close(started); <-release; return nil })}}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { close(release); _ = h.Close(context.Background()) }()
	cs := connect(t, s, "")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "ok"}); err != nil {
		t.Fatalf("sink delayed response: %v", err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("sink not started")
	}
}

func TestMiddlewareBoundsAndCaptureSnapshot(t *testing.T) {
	sink := new(memorySink)
	b := newBuffer(t, BufferOptions{Manual: true, Sinks: []Sink{sink}})
	h := &Handle{buffer: b, options: Options{ServerName: "test", CaptureArguments: true, Redaction: Redaction{Allow: []string{"safe"}}}}
	req := &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Name: strings.Repeat("界", 150), Arguments: json.RawMessage(`{"safe":9007199254740993,"secret":"hidden"}`)}}
	next := func(context.Context, string, mcp.Request) (mcp.Result, error) {
		req.Params.Arguments = json.RawMessage(`{"secret":"mutated"}`)
		return &mcp.CallToolResult{IsError: true, Meta: mcp.Meta{ErrorKindMetaKey: "unknown"}, Content: []mcp.Content{&mcp.TextContent{Text: "not found " + strings.Repeat("界", 2001)}}}, nil
	}
	if _, err := h.middleware(next)(context.Background(), "tools/call", req); err != nil {
		t.Fatal(err)
	}
	if err := h.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	e := sink.snapshot()[0]
	if len([]rune(e.ToolName)) != 128 || len([]rune(*e.ErrorMessage)) != 2000 || *e.ErrorKind != NotFound {
		t.Fatal(e)
	}
	if string(e.Arguments) != `{"safe":9007199254740993,"secret":{"__type":"string"}}` {
		t.Fatal(string(e.Arguments))
	}
}

func TestMiddlewareSerializationFailurePreservesSuccessfulResult(t *testing.T) {
	sink := new(memorySink)
	b := newBuffer(t, BufferOptions{Manual: true, Sinks: []Sink{sink}})
	h := &Handle{buffer: b, options: Options{ServerName: "test", ResolveIdentity: func(context.Context, CallContext) (Identity, error) {
		return Identity{UserID: "must-not-leak"}, errors.New("resolver failed")
	}}}
	req := &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Name: "test"}}
	result := &mcp.CallToolResult{StructuredContent: make(chan int), Meta: mcp.Meta{ErrorKindMetaKey: "internal"}}
	got, err := h.middleware(func(context.Context, string, mcp.Request) (mcp.Result, error) { return result, nil })(context.Background(), "tools/call", req)
	if got != result || err != nil {
		t.Fatal("telemetry changed outcome")
	}
	if err := h.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	e := sink.snapshot()[0]
	if !e.Success || e.ResponseBytes != 0 || e.RequestBytes != 0 || e.ErrorKind != nil || e.ErrorMessage != nil || e.UserID != nil {
		t.Fatal(e)
	}
}
