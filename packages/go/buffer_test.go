package mcpsignals

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type sinkFunc func(context.Context, []ToolCallEvent) error

func (f sinkFunc) Write(ctx context.Context, events []ToolCallEvent) error { return f(ctx, events) }

type memorySink struct {
	mu     sync.Mutex
	events []ToolCallEvent
}

func (s *memorySink) Write(_ context.Context, events []ToolCallEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, events...)
	return nil
}
func (s *memorySink) snapshot() []ToolCallEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]ToolCallEvent(nil), s.events...)
}
func newBuffer(t *testing.T, o BufferOptions) *EventBuffer {
	t.Helper()
	b, err := NewEventBuffer(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = b.Close(ctx)
	})
	return b
}

func TestBufferManualConcurrentDrain(t *testing.T) {
	s := new(memorySink)
	b := newBuffer(t, BufferOptions{Sinks: []Sink{s}, Manual: true, BufferSize: 1})
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Go(func() {
			if !b.Push(ToolCallEvent{EventType: "tool_call"}) {
				t.Error("dropped event")
			}
		})
	}
	wg.Wait()
	if len(s.snapshot()) != 0 {
		t.Fatal("manual mode wrote automatically")
	}
	if err := b.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(s.snapshot()) != 100 {
		t.Fatal("flush did not drain")
	}
	b.Push(ToolCallEvent{})
	if err := b.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(s.snapshot()) != 101 {
		t.Fatal("close did not drain")
	}
	if b.Push(ToolCallEvent{}) {
		t.Fatal("accepted event after close")
	}
	if err := b.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestBufferAutomaticTriggers(t *testing.T) {
	for _, mode := range []string{"size", "interval"} {
		t.Run(mode, func(t *testing.T) {
			written := make(chan struct{}, 1)
			opts := BufferOptions{BufferSize: 100, FlushInterval: time.Hour, Sinks: []Sink{sinkFunc(func(context.Context, []ToolCallEvent) error { written <- struct{}{}; return nil })}}
			if mode == "size" {
				opts.BufferSize = 1
			} else {
				opts.FlushInterval = time.Millisecond
			}
			b := newBuffer(t, opts)
			b.Push(ToolCallEvent{})
			select {
			case <-written:
			case <-time.After(time.Second):
				t.Fatal("no automatic flush")
			}
		})
	}
}

func TestBufferBlockedSinkDoesNotBlockPushAndFlushWaits(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	b := newBuffer(t, BufferOptions{BufferSize: 1, Sinks: []Sink{sinkFunc(func(context.Context, []ToolCallEvent) error { close(started); <-release; return nil })}})
	b.Push(ToolCallEvent{})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("sink never started")
	}
	// An already-running write must be included, even when the queue is empty.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := b.Flush(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("flush returned early: %v", err)
	}
	if err := b.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close returned early: %v", err)
	}
}

func TestBufferFailureIsolationAndCapacity(t *testing.T) {
	s := new(memorySink)
	for _, fail := range []sinkFunc{
		func(context.Context, []ToolCallEvent) error { return errors.New("offline") },
		func(context.Context, []ToolCallEvent) error { panic("private data") },
	} {
		b := newBuffer(t, BufferOptions{Manual: true, MaxQueueSize: 2, Sinks: []Sink{fail, s}})
		if !b.Push(ToolCallEvent{}) || !b.Push(ToolCallEvent{}) || b.Push(ToolCallEvent{}) {
			t.Fatal("capacity policy")
		}
		if err := b.Flush(context.Background()); err == nil {
			t.Fatal("explicit flush hid failure")
		}
		if b.Stats().Dropped != 1 || b.Stats().SinkErrors != 1 {
			t.Fatal(b.Stats())
		}
	}
	if len(s.snapshot()) != 4 {
		t.Fatal("failing sink prevented healthy sink")
	}
}

func TestBufferPushAfterCloseIsCounted(t *testing.T) {
	b := newBuffer(t, BufferOptions{Manual: true})
	if err := b.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b.Push(ToolCallEvent{}) || b.Stats().Dropped != 1 {
		t.Fatal(b.Stats())
	}
}

func TestZeroEventBufferFailsInsteadOfHanging(t *testing.T) {
	var b EventBuffer
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if b.Push(ToolCallEvent{}) || b.Stats().Dropped != 1 {
		t.Fatal(b.Stats())
	}
	if err := b.Flush(ctx); !errors.Is(err, errUninitialized) {
		t.Fatal(err)
	}
	if err := b.Close(ctx); !errors.Is(err, errUninitialized) {
		t.Fatal(err)
	}
}

func TestBufferCanceledFlushPreservesQueue(t *testing.T) {
	s := new(memorySink)
	b := newBuffer(t, BufferOptions{Manual: true, Sinks: []Sink{s}})
	b.Push(ToolCallEvent{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := b.Flush(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := b.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(s.snapshot()) != 1 {
		t.Fatal("canceled flush lost queued event")
	}
}

func TestConsoleSinkJSONLines(t *testing.T) {
	var dst bytes.Buffer
	s := NewConsoleSink(&dst)
	events := []ToolCallEvent{{EventType: "tool_call", ToolName: "one"}, {EventType: "tool_call", ToolName: "two"}}
	if err := s.Write(context.Background(), events); err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(dst.Bytes()), []byte("\n"))
	if len(lines) != 2 {
		t.Fatal(dst.String())
	}
	for _, line := range lines {
		var e ToolCallEvent
		if err := json.Unmarshal(line, &e); err != nil {
			t.Fatal(err)
		}
		if e.EventType != "tool_call" {
			t.Fatal(string(line))
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Write(ctx, events); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestConcurrentAutomaticAndExplicitFlushesDoNotLoseOrDuplicateEvents(t *testing.T) {
	s := new(memorySink)
	b := newBuffer(t, BufferOptions{BufferSize: 5, FlushInterval: time.Millisecond, Sinks: []Sink{s}})
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		i := i
		wg.Go(func() {
			if !b.Push(ToolCallEvent{RequestBytes: i}) {
				t.Error("dropped event")
			}
			if i%7 == 0 {
				if err := b.Flush(context.Background()); err != nil {
					t.Error(err)
				}
			}
		})
	}
	wg.Wait()
	for i := 0; i < 5; i++ {
		wg.Go(func() {
			if err := b.Close(context.Background()); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	events := s.snapshot()
	if len(events) != 100 {
		t.Fatal(len(events))
	}
	seen := make(map[int]bool)
	for _, e := range events {
		if seen[e.RequestBytes] {
			t.Fatal("duplicate", e.RequestBytes)
		}
		seen[e.RequestBytes] = true
	}
}

func TestExplicitFlushPassesCancellationToSink(t *testing.T) {
	started := make(chan struct{})
	b := newBuffer(t, BufferOptions{Manual: true, Sinks: []Sink{sinkFunc(func(ctx context.Context, _ []ToolCallEvent) error { close(started); <-ctx.Done(); return ctx.Err() })}})
	b.Push(ToolCallEvent{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- b.Flush(ctx) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("sink not started")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("flush ignored cancellation")
	}
	if err := b.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}
