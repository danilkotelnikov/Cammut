import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>()
  return {
    ...real,
    api: {
      ...real.api,
      upstreams: { list: vi.fn(), add: vi.fn(), patch: vi.fn(), remove: vi.fn(), test: vi.fn() },
      secrets: { list: vi.fn(), put: vi.fn(), remove: vi.fn() },
    },
  }
})

import { api } from "../api"
import { Servers } from "./Servers"

const gh = {
  name: "github",
  url: "https://x.example/mcp",
  bearer_env: "",
  bearer_secret: "GITHUB_PAT",
  auth_header: "",
  secret_set: false,
  enabled: true,
  status: "unreachable" as const,
  tools: 0,
  last_error: "401",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.upstreams.list).mockResolvedValue([gh])
})

describe("Servers", () => {
  it("lists upstreams with their status and secret state", async () => {
    render(<Servers />)
    expect(await screen.findByText("github")).toBeInTheDocument()
    expect(screen.getByText("unreachable")).toBeInTheDocument()
    expect(screen.getByText("GITHUB_PAT missing")).toBeInTheDocument()
  })

  it("keeps a typed secret out of the DOM once the dialog is closed, and never sends it without Save", async () => {
    const user = userEvent.setup()
    render(<Servers />)
    await user.click(await screen.findByRole("button", { name: "Secret" }))
    await user.type(await screen.findByLabelText("Value"), "github_pat_SUPERSECRET")
    expect(screen.getByLabelText("Value")).toHaveValue("github_pat_SUPERSECRET")
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByLabelText("Value")).not.toBeInTheDocument())
    expect(document.body.innerHTML).not.toContain("SUPERSECRET")
    expect(api.secrets.put).not.toHaveBeenCalled()
  })

  it("saves a secret under its name and shows only a confirmation, never the value", async () => {
    vi.mocked(api.secrets.put).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<Servers />)
    await user.click(await screen.findByRole("button", { name: "Secret" }))
    await user.type(await screen.findByLabelText("Value"), "github_pat_SUPERSECRET")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(api.secrets.put).toHaveBeenCalledWith("GITHUB_PAT", "github_pat_SUPERSECRET", { purpose: "mcp-upstream-bearer", hosts: ["x.example"] }))
    expect(await screen.findByText("Secret GITHUB_PAT saved for github.")).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain("SUPERSECRET")
  })

  it("turns a failed save into a readable message and keeps the dialog usable", async () => {
    const { ApiError } = await import("../api")
    vi.mocked(api.secrets.put).mockRejectedValue(new ApiError(400, "invalid input: secret names look like GITHUB_PAT"))
    const user = userEvent.setup()
    render(<Servers />)
    await user.click(await screen.findByRole("button", { name: "Secret" }))
    await user.type(await screen.findByLabelText("Value"), "x")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText(/secret names look like GITHUB_PAT/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("shows an empty state and survives the API being unreachable", async () => {
    const { ApiError } = await import("../api")
    vi.mocked(api.upstreams.list).mockRejectedValue(new ApiError(0, "Could not reach the server."))
    render(<Servers />)
    expect(await screen.findByText("Could not reach the server.")).toBeInTheDocument()
  })

  it("forgets a secret typed into Add server when that dialog is cancelled and reopened", async () => {
    const user = userEvent.setup()
    render(<Servers />)
    await user.click(await screen.findByRole("button", { name: "Add server" }))
    await user.type(await screen.findByLabelText(/Secret value/), "github_pat_SUPERSECRET")
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByLabelText(/Secret value/)).not.toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: "Add server" }))
    expect(await screen.findByLabelText(/Secret value/)).toHaveValue("")
  })

  it("the Composio preset names the secret and sends the key in x-api-key", async () => {
    vi.mocked(api.upstreams.add).mockResolvedValue({ name: "composio" })
    vi.mocked(api.secrets.put).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<Servers />)
    await user.click(await screen.findByRole("button", { name: "Add server" }))
    await user.click(await screen.findByRole("button", { name: "Composio" }))
    expect(screen.getByLabelText(/Key header/)).toHaveValue("x-api-key")
    const addr = screen.getByLabelText(/Address/)
    await user.type(addr, "abc123?user_id=u1")
    await user.type(screen.getByLabelText(/Secret value/), "ck_test")
    await user.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() =>
      expect(api.upstreams.add).toHaveBeenCalledWith({
        name: "composio",
        url: "https://backend.composio.dev/v3/mcp/abc123?user_id=u1",
        bearer_secret: "COMPOSIO_API_KEY",
        auth_header: "x-api-key",
      }),
    )
    expect(api.secrets.put).toHaveBeenCalledWith("COMPOSIO_API_KEY", "ck_test", expect.objectContaining({ purpose: "mcp-upstream-bearer" }))
  })

  it("edits the key header of an existing server from the secret dialog", async () => {
    vi.mocked(api.upstreams.patch).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<Servers />)
    await user.click(await screen.findByRole("button", { name: "Secret" }))
    await user.type(await screen.findByLabelText(/Key header/), "x-api-key")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(api.upstreams.patch).toHaveBeenCalledWith("github", { auth_header: "x-api-key" }))
    expect(api.secrets.put).not.toHaveBeenCalled()
    expect(await screen.findByText("Key header saved for github.")).toBeInTheDocument()
  })
})
