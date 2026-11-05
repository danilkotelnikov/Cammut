// Independent client for TestInteropWithOfficialNodeClient: the official TypeScript MCP SDK against Cammut's /mcp.
// Reads URL and TOK from the environment and the SDK from CAMMUT_INTEROP_SDK (a path to @modelcontextprotocol/sdk).
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const sdk = process.env.CAMMUT_INTEROP_SDK;
const load = (p) => import(pathToFileURL(path.join(sdk, 'dist', 'esm', p)).href);
const { Client } = await load('client/index.js');
const { StreamableHTTPClientTransport } = await load('client/streamableHttp.js');

const transport = new StreamableHTTPClientTransport(new URL(process.env.URL), { requestInit: { headers: { Authorization: 'Bearer ' + process.env.TOK } } });
const client = new Client({ name: 'interop', version: '0' });
await client.connect(transport);
const tools = await client.listTools();
const wrote = await client.callTool({ name: 'memory__memory_remember', arguments: { project: 'InteropNode', kind: 'finding', title: 'node client', body: 'written by the official TypeScript SDK' } });
const got = await client.callTool({ name: 'memory__memory_recall', arguments: { project: 'InteropNode', query: 'official TypeScript SDK' } });
console.log(JSON.stringify({ server: client.getServerVersion()?.name, tools: tools.tools.map((t) => t.name).sort(), remember_error: !!wrote.isError, recall: got.content[0].text }));
await client.close();
