package mcpsignals

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"sync"
)

// Sink writes a read-only batch. Implementations must honor ctx cancellation.
// A buffer serializes its writes, but sharing a sink between buffers requires
// a concurrency-safe implementation. Delivery is best-effort, without retries.
type Sink interface {
	Write(context.Context, []ToolCallEvent) error
}

// ConsoleSink writes one JSON object per line, serializing concurrent writes.
// Like any io.Writer, a blocked underlying Write cannot be interrupted by ctx.
type ConsoleSink struct {
	mu     sync.Mutex
	writer io.Writer
}

// NewConsoleSink defaults to stderr when writer is nil. Never use stdout when
// the MCP server uses stdio: stdout is reserved for protocol traffic.
func NewConsoleSink(writer io.Writer) *ConsoleSink {
	if writer == nil {
		writer = os.Stderr
	}
	return &ConsoleSink{writer: writer}
}

// Write encodes events as JSON lines. Context is checked before each event.
func (s *ConsoleSink) Write(ctx context.Context, events []ToolCallEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	encoder := json.NewEncoder(s.writer)
	for _, event := range events {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := encoder.Encode(event); err != nil {
			return err
		}
	}
	return nil
}
