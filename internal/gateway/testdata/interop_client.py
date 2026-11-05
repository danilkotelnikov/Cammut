# Independent client for TestInteropWithOfficialClients: the official Python MCP SDK against Cammut's /mcp.
# Reads URL and TOK from the environment; prints one JSON line. Never prints the token.
import asyncio, json, os, sys

from mcp import ClientSession

try:
    from mcp.client.streamable_http import streamablehttp_client as connect
except ImportError:  # newer SDKs renamed it
    from mcp.client.streamable_http import streamable_http_client as connect


async def main():
    url, tok = os.environ["URL"], os.environ["TOK"]
    async with connect(url, headers={"Authorization": "Bearer " + tok}) as streams:
        read, write = streams[0], streams[1]
        async with ClientSession(read, write) as s:
            init = await s.initialize()
            tools = await s.list_tools()
            wrote = await s.call_tool("memory__memory_remember", {"project": "Interop", "kind": "finding", "title": "python client", "body": "written by the official Python SDK"})
            got = await s.call_tool("memory__memory_recall", {"project": "Interop", "query": "official Python SDK"})
            print(json.dumps({
                "server": init.serverInfo.name,
                "tools": sorted(t.name for t in tools.tools),
                "remember_error": bool(wrote.isError),
                "recall": got.content[0].text,
            }))


asyncio.run(main())
