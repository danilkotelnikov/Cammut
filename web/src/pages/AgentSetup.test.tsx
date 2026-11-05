import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>()
  return { ...real, api: { ...real.api, me: vi.fn(), tokens: { list: vi.fn(), create: vi.fn(), setScopes: vi.fn(), revoke: vi.fn() } } }
})

import { api } from "../api"
import { AgentSetup, readScopes, writeScopes } from "./AgentSetup"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.tokens.list).mockResolvedValue([])
  vi.mocked(api.me).mockResolvedValue({ username: "alice", github_linked: false, site_origin: "https://cammut.example" })
})

describe("Agent Setup", () => {
  it("shows capability stages separately and does not claim automatic memory from an MCP connection", async () => {
    render(<AgentSetup />)
    expect(await screen.findByText(/Tools connected:/)).toHaveTextContent(/unverified/)
    expect(screen.getByText(/Capture:/)).toHaveTextContent(/unverified/)
    expect(screen.getByText(/Recall injected:/)).toHaveTextContent(/unverified/)
    expect(screen.getByText(/Compaction:/)).toHaveTextContent(/unverified/)
    expect(screen.getByText(/MCP access alone/i)).toBeInTheDocument()
  })

  it("fills the MCP endpoint from the server's site origin when the console is on the private tunnel, and keeps a hand-typed one", async () => {
    vi.mocked(api.me).mockResolvedValue({ username: "alice", github_linked: false, site_origin: "https://cammut.example" })
    const user = userEvent.setup()
    render(<AgentSetup />)
    const field = await screen.findByLabelText(/MCP endpoint/)
    await waitFor(() => expect(field).toHaveValue("https://cammut.example/mcp"))
    expect(document.body.innerHTML).not.toMatch(/tiffany/i)
    await user.clear(field)
    await user.type(field, "https://mine.example/mcp")
    expect(field).toHaveValue("https://mine.example/mcp")
  })

  it("leaves the MCP endpoint empty when the server knows no site origin", async () => {
    vi.mocked(api.me).mockResolvedValue({ username: "alice", github_linked: false, site_origin: "" })
    render(<AgentSetup />)
    expect(await screen.findByLabelText(/MCP endpoint/)).toHaveValue("")
  })

  it("creates a client-specific read-only credential and reveals it only once, outside the config preview", async () => {
    vi.mocked(api.tokens.create).mockResolvedValue({
      label: "claude-test", scopes: readScopes, expires_at: null, token: "cmt_PLAINTEXT",
    })
    const user = userEvent.setup()
    render(<AgentSetup />)
    await user.type(await screen.findByLabelText("Token label"), "claude-test")
    await user.click(screen.getByRole("button", { name: "Create scoped token" }))
    await waitFor(() => expect(api.tokens.create).toHaveBeenCalledWith({
      label: "claude-test",
      scopes: readScopes,
      expires_in_hours: 24 * 30,
    }))
    expect(await screen.findByTestId("setup-token-plaintext")).toHaveTextContent("cmt_PLAINTEXT")
    expect(screen.getByLabelText("Install preview")).not.toHaveTextContent("cmt_PLAINTEXT")
    await user.click(screen.getByRole("button", { name: "I saved the token" }))
    expect(screen.queryByTestId("setup-token-plaintext")).not.toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain("cmt_PLAINTEXT")
  })

  it("mints exactly the scope names the REST hooks and the MCP tools check", () => {
    // REST (internal/memoryapi gate ops) and MCP (internal/memorymcp tool names); a token from this page serves both.
    for (const rest of ["memory/brief", "memory/recall"]) expect(readScopes).toContain(rest)
    expect(writeScopes).toContain("memory/remember")
    for (const tool of ["memory_projects", "memory_brief", "memory_recall", "memory_history"]) expect(readScopes).toContain("memory/" + tool)
    for (const tool of ["memory_remember", "memory_handoff", "memory_confirm"]) expect(writeScopes).toContain("memory/" + tool)
  })

  it("shows the expiry and sends none for never", async () => {
    vi.mocked(api.tokens.create).mockResolvedValue({ label: "t", scopes: readScopes, expires_at: null, token: "cmt_X" })
    const user = userEvent.setup()
    render(<AgentSetup />)
    await user.selectOptions(await screen.findByLabelText("Token expiry"), "never")
    await user.type(screen.getByLabelText("Token label"), "t")
    await user.click(screen.getByRole("button", { name: "Create scoped token" }))
    await waitFor(() => expect(api.tokens.create).toHaveBeenCalledWith({ label: "t", scopes: readScopes }))
  })

  it("can revoke a credential without implying deletion of other client entries", async () => {
    vi.mocked(api.tokens.list).mockResolvedValue([{
      id: 1, label: "codex-test", scopes: ["memory/memory_brief"], profile: "lazy", revoked: false,
      created_at: null, last_used_at: null, expires_at: null,
    }])
    vi.mocked(api.tokens.revoke).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AgentSetup />)
    await user.click(await screen.findByRole("button", { name: "Revoke codex-test" }))
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }))
    await waitFor(() => expect(api.tokens.revoke).toHaveBeenCalledWith("codex-test"))
  })
})
