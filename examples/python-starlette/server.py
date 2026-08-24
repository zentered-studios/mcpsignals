import contextlib

from mcp.server.mcpserver import MCPServer
from mcpsignals import instrument
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

server = MCPServer("notes")

instrument(server, server_name="notes", server_version="1.0.0")

notes: list[str] = []


@server.tool()
def add_note(text: str) -> str:
    """Append a note."""
    notes.append(text)
    return f"Saved: {text}"


async def health(request):
    return JSONResponse({"status": "ok"})


# stateless_http=True keeps this example a single copy-pasteable curl call -
# no session handshake required. A stateful server (the default) needs an
# `initialize` call first to get a session id, which is the more typical
# production setup.
mcp_app = server.streamable_http_app(stateless_http=True)


@contextlib.asynccontextmanager
async def lifespan(app: Starlette):
    # The MCP session manager needs to be started/stopped alongside the host
    # app - mounting the sub-app alone does not do this for you.
    async with server.session_manager.run():
        yield


app = Starlette(
    routes=[Route("/health", health), Mount("/", app=mcp_app)],
    lifespan=lifespan,
)
