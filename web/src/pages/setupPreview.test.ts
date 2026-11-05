import { describe, expect, it } from "vitest"
import { endpointFromConsole, previewConfig } from "./setupPreview"

const endpoint = "https://cammut.example/mcp"

describe("setup preview", () => {
  it("takes the public MCP endpoint from the server's site origin when the console is reached through the private admin tunnel", () => {
    expect(endpointFromConsole("http://cammut.localhost:7422", "https://cammut.example")).toBe(endpoint)
    expect(endpointFromConsole("http://cammut.localhost:7422", "https://cammut.example/")).toBe(endpoint)
    expect(endpointFromConsole("https://owner.example.org", "https://cammut.example")).toBe("https://owner.example.org/mcp")
  })

  it("never invents an endpoint: with no page origin to use and no site origin it is empty", () => {
    expect(endpointFromConsole("http://cammut.localhost:7422")).toBe("")
    expect(endpointFromConsole("http://cammut.localhost:7422", "")).toBe("")
    expect(endpointFromConsole("http://cammut.localhost:7422", "not a url")).toBe("")
    expect(endpointFromConsole("http://cammut.localhost:7422", "http://public.example")).toBe("")
    expect(() => previewConfig("claude", "", "{}")).toThrow(/valid MCP endpoint/)
  })

  it("adds Claude Code's HTTP entry without replacing unrelated MCP entries or hooks", () => {
    const original = '{\n  "hooks": {"Stop": [{"command": "keep-me"}]},\n  "mcpServers": {"existing": {"command": "node", "args": ["server.js"]}}\n}'
    const result = previewConfig("claude", endpoint, original)
    const merged = JSON.parse(result.install)
    expect(merged.hooks.Stop[0].command).toBe("keep-me")
    expect(merged.mcpServers.existing).toEqual({ command: "node", args: ["server.js"] })
    expect(merged.mcpServers.cammut).toEqual({
      type: "http",
      url: endpoint,
      headers: { Authorization: "Bearer ${CAMMUT_TOKEN_CLAUDE}" },
    })
    expect(result.uninstall).toBe(original)
    expect(result.install).not.toContain("cmt_PLAINTEXT")
  })

  it("appends an isolated Codex TOML table and preserves original bytes for an exact rollback preview", () => {
    const original = "model = \"gpt-5\"\n[mcp_servers.existing]\nurl = \"https://other.example/mcp\"\n"
    const result = previewConfig("codex", endpoint, original)
    expect(result.install.startsWith(original)).toBe(true)
    expect(result.install).toContain('[mcp_servers.cammut]\nurl = "https://cammut.example/mcp"\nbearer_token_env_var = "CAMMUT_TOKEN_CODEX"')
    expect(result.uninstall).toBe(original)
  })

  it("fails closed on existing Cammut entries, malformed JSON and invalid or credential-bearing endpoints", () => {
    expect(() => previewConfig("claude", endpoint, '{"mcpServers":{"cammut":{"command":"keep-me"}}}')).toThrow(/already exists/)
    expect(() => previewConfig("claude", endpoint, '{"hooks":')).toThrow(/valid JSON/)
    expect(() => previewConfig("codex", endpoint, '[mcp_servers.cammut]\nurl = "https://other.example/mcp"')).toThrow(/already exists/)
    expect(() => previewConfig("codex", "https://user:password@host.example/mcp", "")).toThrow(/credentials/)
    expect(() => previewConfig("claude", "http://public.example/mcp", "{}")).toThrow(/HTTPS/)
    expect(() => previewConfig("claude", "https://host.example/mcp?token=secret", "{}")).toThrow(/query/)
  })

  it("refuses alternate Codex table spellings instead of silently adding a conflicting server", () => {
    for (const original of [
      "[mcp_servers.'cammut']\nurl = \"https://other.example/mcp\"",
      "['mcp_servers'.\"cammut\"]\nurl = \"https://other.example/mcp\"",
      'mcp_servers = { cammut = { url = "https://other.example/mcp" } }',
    ]) {
      expect(() => previewConfig("codex", endpoint, original)).toThrow(/inspect.*manually/i)
    }
  })
})
