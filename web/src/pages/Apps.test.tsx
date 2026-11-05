import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>()
  return { ...real, api: { ...real.api, oauth: { clients: vi.fn(), create: vi.fn(), setRedirects: vi.fn(), remove: vi.fn(), removeGrant: vi.fn() } } }
})

import { api } from "../api"
import { Apps, parseUris } from "./Apps"

const app = {
  id: "cmc_1234",
  name: "Gemini",
  redirect_uris: ["https://gemini.test/cb"],
  scopes: ["hindsight/recall"],
  created_at: "2026-10-21T10:00:00Z",
  grants: [{ id: 5, created_at: "2026-10-21T10:05:00Z", last_used_at: null }],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.oauth.clients).mockResolvedValue([app])
})

describe("Apps", () => {
  it("lists apps with scopes, addresses and connections but no secret", async () => {
    render(<Apps />)
    expect(await screen.findByText("Gemini")).toBeInTheDocument()
    expect(screen.getByText("hindsight/recall")).toBeInTheDocument()
    expect(screen.getByText("https://gemini.test/cb")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain("cms_")
  })

  it("shows the client secret once and removes it when the dialog closes", async () => {
    vi.mocked(api.oauth.create).mockResolvedValue({ client: app, client_id: "cmc_new", client_secret: "cms_SECRET" })
    const user = userEvent.setup()
    render(<Apps />)
    await user.click(await screen.findByRole("button", { name: "New app" }))
    await user.type(await screen.findByLabelText("Name"), "Gemini 2")
    await user.type(screen.getByLabelText(/Scopes/), "hindsight/recall")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(api.oauth.create).toHaveBeenCalledWith({ name: "Gemini 2", redirect_uris: [], scopes: ["hindsight/recall"] })
    expect(await screen.findByTestId("client-secret")).toHaveTextContent("cms_SECRET")
    await user.click(screen.getByRole("button", { name: "I have saved it" }))
    await waitFor(() => expect(screen.queryByTestId("client-secret")).not.toBeInTheDocument())
    expect(document.body.innerHTML).not.toContain("cms_SECRET")
  })

  it("asks for a scope before calling the server", async () => {
    const user = userEvent.setup()
    render(<Apps />)
    await user.click(await screen.findByRole("button", { name: "New app" }))
    await user.type(await screen.findByLabelText("Name"), "x")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(await screen.findByText("Choose at least one scope.")).toBeInTheDocument()
    expect(api.oauth.create).not.toHaveBeenCalled()
  })

  it("ends one connection", async () => {
    vi.mocked(api.oauth.removeGrant).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<Apps />)
    await user.click(await screen.findByRole("button", { name: "Disconnect" }))
    expect(api.oauth.removeGrant).toHaveBeenCalledWith(5)
  })

  it("splits pasted addresses", () => {
    expect(parseUris("https://a.test/x, https://b.test/y\nhttps://c.test/z")).toEqual(["https://a.test/x", "https://b.test/y", "https://c.test/z"])
  })
})
