import contextlib

from fastapi import FastAPI
from mcp.server.mcpserver import MCPServer

from mcpsignals import instrument

server = MCPServer("notes")

instrument(server, server_name="notes", server_version="1.0.0")

notes: list[str] = []


@server.tool()
def add_note(text: str) -> str:
    """Append a note."""
    notes.append(text)
    return f"Saved: {text}"


# stateless_http=True keeps this example a single copy-pasteable curl call -
# no session handshake required. A stateful server (the default) needs an
# `initialize` call first to get a session id, which is the more typical
# production setup.
mcp_app = server.streamable_http_app(stateless_http=True)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    # The MCP session manager needs to be started/stopped alongside the host
    # app - mounting the sub-app alone does not do this for you.
    async with server.session_manager.run():
        yield


app = FastAPI(lifespan=lifespan)
app.mount("/", mcp_app)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
