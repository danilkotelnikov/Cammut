import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>()
  return { ...real, api: { ...real.api, audit: vi.fn(), tokens: { list: vi.fn(), create: vi.fn(), setScopes: vi.fn(), revoke: vi.fn() } } }
})

import { api, ApiError, type AuditRow } from "../api"
import { Audit } from "./Audit"

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  ts: "2026-10-10T12:00:00Z",
  token_id: 0,
  upstream: "admin",
  tool: "token.create",
  ok: true,
  ms: 0,
  note: "created",
  ip: "198.51.100.7",
  actor: "user:alice",
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.tokens.list).mockResolvedValue([
    { id: 7, label: "warp", scopes: [], revoked: false, created_at: null, last_used_at: null, expires_at: null, profile: "lazy" },
  ])
  vi.mocked(api.audit).mockResolvedValue([])
})

describe("Audit", () => {
  it("shows who acted: the console user, the token's label from its id, or the bare id", async () => {
    vi.mocked(api.audit).mockResolvedValue([
      row(),
      row({ actor: "", token_id: 7, upstream: "github", tool: "search", note: "" }),
      row({ actor: "", token_id: 99, upstream: "github", tool: "fetch", note: "" }),
    ])
    render(<Audit />)
    expect(await screen.findByText("user:alice")).toBeInTheDocument()
    expect(await screen.findByText("warp")).toBeInTheDocument()
    expect(screen.getByText("token #99")).toBeInTheDocument()
  })

  it("starts from the first page, then sends only the filters that were set", async () => {
    const user = userEvent.setup()
    render(<Audit />)
    await waitFor(() => expect(api.audit).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.audit).mock.calls[0][0]).toMatchObject({ limit: 50, offset: 0 })
    await user.type(screen.getByLabelText("Server"), "admin")
    await user.selectOptions(screen.getByLabelText(/^Result/), "false")
    await user.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(api.audit).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.audit).mock.calls[1][0]).toMatchObject({ upstream: "admin", ok: "false", limit: 50, offset: 0 })
  })

  it("offers Load more only after a full page and appends the next one at the right offset", async () => {
    const page = Array.from({ length: 50 }, (_, i) => row({ ms: i }))
    vi.mocked(api.audit).mockResolvedValueOnce(page).mockResolvedValueOnce([row({ note: "the last row" })])
    const user = userEvent.setup()
    render(<Audit />)
    await user.click(await screen.findByRole("button", { name: "Load more" }))
    await waitFor(() => expect(api.audit).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.audit).mock.calls[1][0]).toMatchObject({ offset: 50, limit: 50 })
    expect(await screen.findByText("the last row")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument()
  })

  it("explains a refusal in words and does not claim there is simply nothing to show", async () => {
    vi.mocked(api.audit).mockRejectedValue(new ApiError(400, "bad since time (use RFC 3339)"))
    render(<Audit />)
    expect(await screen.findByText(/use RFC 3339/)).toBeInTheDocument()
    expect(screen.queryByText("Nothing matches.")).not.toBeInTheDocument()
  })
})
