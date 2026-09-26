// A runnable stdio MCP server. Protocol traffic uses stdout; telemetry uses stderr.
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	mcpsignals "github.com/zentered-studios/mcpsignals/packages/go/v2"
)

type input struct {
	Name string `json:"name" jsonschema:"Name to greet"`
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	info := &mcp.Implementation{Name: "mcpsignals-go-example", Version: "1.0.0"}
	server := mcp.NewServer(info, nil)
	telemetry, err := mcpsignals.Instrument(server, mcpsignals.Options{
		ServerName: info.Name, ServerVersion: info.Version, Transport: "stdio",
		Buffer: mcpsignals.BufferOptions{Sinks: []mcpsignals.Sink{mcpsignals.NewConsoleSink(nil)}, BufferSize: 1},
	})
	if err != nil {
		return err
	}
	mcp.AddTool(server, &mcp.Tool{Name: "greet", Description: "Greet someone"}, func(_ context.Context, _ *mcp.CallToolRequest, in input) (*mcp.CallToolResult, any, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "Hello, " + in.Name + "!"}}}, nil, nil
	})
	// Run ends when stdin closes or the process receives a shutdown signal.
	runErr := server.Run(ctx, &mcp.StdioTransport{})
	// The request context may already be canceled; use a fresh shutdown deadline.
	flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	closeErr := telemetry.Close(flushCtx)
	if errors.Is(runErr, context.Canceled) {
		runErr = nil
	}
	return errors.Join(runErr, closeErr)
}

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
