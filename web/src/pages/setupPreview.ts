export type Client = "claude" | "codex" | "generic"
const envName: Record<Client, string> = {
  claude: "CAMMUT_TOKEN_CLAUDE",
  codex: "CAMMUT_TOKEN_CODEX",
  generic: "CAMMUT_TOKEN_MCP",
}

/**
 * The public MCP endpoint, never a literal: the console's own https origin when it is served from the public name,
 * otherwise the server's -site-origin (reported by /api/v1/me) when the console is on the private tunnel. Empty if neither.
 */
export function endpointFromConsole(origin: string, siteOrigin = ""): string {
  const publicOrigin = (value: string): string => {
    try {
      const url = new URL(value)
      return url.protocol === "https:" && !url.hostname.endsWith(".localhost") ? url.origin : ""
    } catch {
      return ""
    }
  }
  const base = publicOrigin(origin) || publicOrigin(siteOrigin)
  return base ? base + "/mcp" : ""
}

export function tokenEnvName(client: Client): string {
  return envName[client]
}

function checkedEndpoint(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error("Enter a valid MCP endpoint URL.")
  }
  if (url.username || url.password) throw new Error("Do not put credentials in the endpoint URL.")
  if (url.search || url.hash) throw new Error("Endpoint query parameters and fragments are not allowed.")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Use HTTPS, or HTTP to a verified loopback MCP listener.")
  }
  if (url.pathname !== "/mcp") throw new Error("Use the MCP endpoint ending in /mcp, not the private console listener.")
  return url.href
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Preview only: this never reads or writes the user's configuration or sends pasted content to the API. */
export function previewConfig(client: Client, endpoint: string, existing: string): { install: string; uninstall: string } {
  const url = checkedEndpoint(endpoint)
  if (client === "generic") return { install: "", uninstall: existing }
  if (client === "codex") {
    // Reject both dotted tables and inline entries; never replace an existing Cammut definition.
    if (/^\s*\[\[?\s*["']?mcp_servers["']?\s*\.\s*["']?cammut["']?(?:\s*\.|\s*\])/m.test(existing) ||
      /^\s*\[\s*["']?mcp_servers["']?\s*\][\s\S]*?^\s*["']?cammut["']?\s*=/m.test(existing)) {
      throw new Error("A Cammut MCP entry already exists. Inspect it manually; this preview will not replace it.")
    }
    if (/^\s*["']?mcp_servers["']?\s*=/m.test(existing) || /^\s*["']?mcp_servers["']?\s*\.\s*["']?cammut["']?\s*=/m.test(existing)) {
      throw new Error("This TOML uses an inline or dotted MCP definition. Inspect it manually; this preview cannot safely merge that form.")
    }
    const separator = existing && !existing.endsWith("\n") ? "\n" : ""
    const install = `${existing}${separator}\n# Cammut setup preview BEGIN\n[mcp_servers.cammut]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = ${JSON.stringify(envName.codex)}\n# Cammut setup preview END\n`
    return { install, uninstall: existing }
  }
  let root: unknown
  try {
    root = JSON.parse(existing.trim() || "{}")
  } catch {
    throw new Error("Paste valid JSON (without comments) for a safe preview; no file has been changed.")
  }
  if (!isObject(root) || (root.mcpServers !== undefined && !isObject(root.mcpServers))) {
    throw new Error("Expected a JSON object with an optional mcpServers object; no file has been changed.")
  }
  const servers = (root.mcpServers ?? {}) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(servers, "cammut")) {
    throw new Error("A Cammut MCP entry already exists. Inspect it manually; this preview will not replace it.")
  }
  const entry = { type: "http", url, headers: { Authorization: `Bearer \${${envName.claude}}` } }
  return {
    install: JSON.stringify({ ...root, mcpServers: { ...servers, cammut: entry } }, null, 2) + "\n",
    uninstall: existing,
  }
}
