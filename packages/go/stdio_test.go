package mcpsignals

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestStdioExampleKeepsStdoutForMCP(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "stdio-example")
	if output, err := exec.Command("go", "build", "-o", binary, "./examples/stdio").CombinedOutput(); err != nil {
		t.Fatalf("example build: %v\n%s", err, output)
	}
	stderr, err := os.CreateTemp(t.TempDir(), "events")
	if err != nil {
		t.Fatal(err)
	}
	defer stderr.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary)
	cmd.Stderr = stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "stdio-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "greet", Arguments: map[string]any{"name": "Ada"}})
	if err != nil {
		_ = session.Close()
		t.Fatal(err)
	}
	if res.IsError || res.Content[0].(*mcp.TextContent).Text != "Hello, Ada!" {
		t.Fatal(res)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := stderr.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	scan := bufio.NewScanner(stderr)
	var events []ToolCallEvent
	for scan.Scan() {
		var e ToolCallEvent
		if err := json.Unmarshal(scan.Bytes(), &e); err != nil {
			t.Fatalf("stderr not JSON lines: %s", scan.Text())
		}
		events = append(events, e)
	}
	if err := scan.Err(); err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].ToolName != "greet" || !events[0].Success || *events[0].Transport != "stdio" || string(events[0].Arguments) != "null" {
		t.Fatalf("events: %+v", events)
	}
}
