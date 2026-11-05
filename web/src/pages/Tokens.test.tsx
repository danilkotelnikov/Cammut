import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>()
  return { ...real, api: { ...real.api, tokens: { list: vi.fn(), create: vi.fn(), setScopes: vi.fn(), revoke: vi.fn() } } }
})

import { api, ApiError } from "../api"
import { Tokens } from "./Tokens"

const row = {
  id: 7,
  label: "warp",
  scopes: ["github/*"],
  revoked: false,
  created_at: "2026-10-10T10:00:00Z",
  last_used_at: null,
  expires_at: null,
  profile: "lazy",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.tokens.list).mockResolvedValue([row])
})

describe("Tokens", () => {
  it("lists tokens with scopes and state but nothing secret", async () => {
    render(<Tokens />)
    expect(await screen.findByText("warp")).toBeInTheDocument()
    expect(screen.getByText("github/*")).toBeInTheDocument()
    expect(screen.getByText("active")).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain("cmt_")
  })

  it("shows a new token exactly once and removes it from the page when the reveal dialog closes", async () => {
    vi.mocked(api.tokens.create).mockResolvedValue({ label: "ci", scopes: ["github/*"], expires_at: null, token: "cmt_PLAINTEXT" })
    const user = userEvent.setup()
    render(<Tokens />)
    await user.click(await screen.findByRole("button", { name: "New token" }))
    await user.type(await screen.findByLabelText("Label"), "ci")
    await user.type(screen.getByLabelText(/Scopes/), "github/*")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(api.tokens.create).toHaveBeenCalledWith({ label: "ci", scopes: ["github/*"], expires_in_hours: undefined })
    expect(await screen.findByTestId("token-plaintext")).toHaveTextContent("cmt_PLAINTEXT")
    expect(screen.getAllByText(/cmt_PLAINTEXT/)).toHaveLength(1)
    await user.click(screen.getByRole("button", { name: "I have saved it" }))
    await waitFor(() => expect(screen.queryByTestId("token-plaintext")).not.toBeInTheDocument())
    expect(document.body.innerHTML).not.toContain("cmt_PLAINTEXT")
  })

  it("rejects a bad scope before calling the server", async () => {
    const user = userEvent.setup()
    render(<Tokens />)
    await user.click(await screen.findByRole("button", { name: "New token" }))
    await user.type(await screen.findByLabelText("Label"), "ci")
    await user.type(screen.getByLabelText(/Scopes/), "bad!scope")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(await screen.findByText(/has characters other than/)).toBeInTheDocument()
    expect(api.tokens.create).not.toHaveBeenCalled()
  })

  it("turns a duplicate label (409) into a readable message and never reveals anything", async () => {
    vi.mocked(api.tokens.create).mockRejectedValue(new ApiError(409, 'already exists: token "ci"'))
    const user = userEvent.setup()
    render(<Tokens />)
    await user.click(await screen.findByRole("button", { name: "New token" }))
    await user.type(await screen.findByLabelText("Label"), "ci")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(await screen.findByText(/already exists/)).toBeInTheDocument()
    expect(screen.queryByTestId("token-plaintext")).not.toBeInTheDocument()
  })
})
