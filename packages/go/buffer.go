package mcpsignals

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// BufferOptions configures best-effort delivery. Zero values select defaults.
type BufferOptions struct {
	Sinks         []Sink
	BufferSize    int           // Automatic size threshold; default 20.
	FlushInterval time.Duration // Default 5 seconds.
	Manual        bool          // Disable all automatic writes, including size-triggered writes.
	MaxQueueSize  int           // Drop newest on overflow; default 1000 pending events.
	WriteTimeout  time.Duration // Automatic flush timeout; default 10 seconds.
}

// BufferStats reports cumulative delivery failures, without logging payloads.
type BufferStats struct {
	Dropped    uint64 // Rejected because the queue was full or the buffer closed.
	SinkErrors uint64
}

// EventBuffer is a bounded, concurrency-safe queue. Push never calls a sink.
// Flush and Close return sink errors; automatic failures are counted in Stats.
// A failed batch is not retried (a sink may have partially committed it).
// Create one with NewEventBuffer. The zero value drops every event and returns
// an error from Flush and Close.
type EventBuffer struct {
	mu      sync.Mutex
	queue   []ToolCallEvent
	closed  bool
	stats   BufferStats
	options BufferOptions
	gate    chan struct{}
	wake    chan struct{}
	stop    chan struct{}
	done    chan struct{}
}

var errUninitialized = errors.New("mcpsignals: EventBuffer must be created with NewEventBuffer")

// initialized reports whether NewEventBuffer built b; it sets every channel.
func (b *EventBuffer) initialized() bool { return b.done != nil }

// NewEventBuffer starts one worker unless Manual is set. No network calls are
// made until events are flushed. Call Close after stopping/draining the server.
func NewEventBuffer(o BufferOptions) (*EventBuffer, error) {
	if o.BufferSize < 0 || o.FlushInterval < 0 || o.MaxQueueSize < 0 || o.WriteTimeout < 0 {
		return nil, errors.New("mcpsignals: buffer settings must not be negative")
	}
	if o.BufferSize == 0 {
		o.BufferSize = 20
	}
	if o.FlushInterval == 0 {
		o.FlushInterval = 5 * time.Second
	}
	if o.MaxQueueSize == 0 {
		o.MaxQueueSize = 1000
	}
	if o.WriteTimeout == 0 {
		o.WriteTimeout = 10 * time.Second
	}
	o.Sinks = append([]Sink(nil), o.Sinks...)
	for _, sink := range o.Sinks {
		if sink == nil {
			return nil, errors.New("mcpsignals: nil sink")
		}
	}
	b := &EventBuffer{options: o, gate: make(chan struct{}, 1), wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{})}
	if o.Manual {
		close(b.done)
	} else {
		go b.run()
	}
	return b, nil
}

// Push accepts an immutable event snapshot. False means closed or full; both
// are counted in Stats.Dropped. Callers must not mutate accepted event data.
func (b *EventBuffer) Push(e ToolCallEvent) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || len(b.queue) >= b.options.MaxQueueSize {
		b.stats.Dropped++
		return false
	}
	b.queue = append(b.queue, e)
	if !b.options.Manual && len(b.queue) >= b.options.BufferSize {
		select {
		case b.wake <- struct{}{}:
		default:
		}
	}
	return true
}

// Stats returns a concurrency-safe copy of the counters.
func (b *EventBuffer) Stats() BufferStats { b.mu.Lock(); defer b.mu.Unlock(); return b.stats }

// Flush waits for earlier writes and attempts all events queued when it obtains
// the flush lock. A canceled context before dequeue preserves pending events.
// After dequeue the batch is attempted once, even on cancellation or failure.
// Sinks must honor ctx; Go cannot interrupt arbitrary user code.
func (b *EventBuffer) Flush(ctx context.Context) error {
	if !b.initialized() {
		return errUninitialized
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case b.gate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-b.gate }()
	if err := ctx.Err(); err != nil {
		return err
	}
	b.mu.Lock()
	batch := b.queue
	b.queue = nil
	b.mu.Unlock()
	if len(batch) == 0 {
		return nil
	}
	var errs []error
	for i, sink := range b.options.Sinks {
		if err := writeSink(ctx, sink, batch); err != nil {
			b.mu.Lock()
			b.stats.SinkErrors++
			b.mu.Unlock()
			errs = append(errs, fmt.Errorf("mcpsignals: sink %d: %w", i, err))
		}
	}
	return errors.Join(errs...)
}

func writeSink(ctx context.Context, sink Sink, batch []ToolCallEvent) (err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("sink panicked")
		}
	}()
	return sink.Write(ctx, batch)
}

// Close stops accepting events and stops the worker, then drains pending and
// in-flight writes. It is idempotent and may be retried with a fresh context
// after a timeout. Stop and drain MCP requests before calling Close.
// Sink ownership remains with the application; Close does not close sinks.
func (b *EventBuffer) Close(ctx context.Context) error {
	if !b.initialized() {
		return errUninitialized
	}
	b.mu.Lock()
	if !b.closed {
		b.closed = true
		close(b.stop)
	}
	b.mu.Unlock()
	select {
	case <-b.done:
	case <-ctx.Done():
		return ctx.Err()
	}
	return b.Flush(ctx)
}

func (b *EventBuffer) run() {
	defer close(b.done)
	ticker := time.NewTicker(b.options.FlushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-b.stop:
			return
		case <-ticker.C:
		case <-b.wake:
		}
		// Prefer shutdown over a buffered wakeup.
		select {
		case <-b.stop:
			return
		default:
		}
		ctx, cancel := context.WithTimeout(context.Background(), b.options.WriteTimeout)
		_ = b.Flush(ctx)
		cancel()
	}
}
