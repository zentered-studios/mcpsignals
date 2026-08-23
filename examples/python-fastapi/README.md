# python-fastapi example

A one-file MCP server (`MCPServer`, mounted into FastAPI over Streamable
HTTP) with `mcpsignals` wired to the default console sink, so every tool
call prints as a JSON line to stdout.

## Run it

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8000
```

## Try it

In another terminal:

```sh
curl -s -X POST http://127.0.0.1:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add_note","arguments":{"text":"hello from curl"}}}'
```

The server's terminal prints a `tool_call` event line - that's `mcpsignals`
recording the call via the console sink.
