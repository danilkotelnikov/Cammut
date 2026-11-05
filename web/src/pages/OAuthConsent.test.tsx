import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>()
  return { ...real, api: { ...real.api, oauth: { request: vi.fn(), approve: vi.fn(), deny: vi.fn() } } }
})

import { api, ApiError } from "../api"
import { OAuthConsent } from "./OAuthConsent"

const assign = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true })
  vi.mocked(api.oauth.request).mockResolvedValue({ client_name: "Gemini", scopes: ["hindsight/recall"], redirect_host: "gemini.test" })
})

const page = (q = "?req=abc") =>
  render(
    <MemoryRouter initialEntries={["/oauth" + q]}>
      <OAuthConsent />
    </MemoryRouter>,
  )

describe("OAuthConsent", () => {
  it("names the app, where it goes back to and what it may use", async () => {
    page()
    expect(await screen.findByText("Gemini")).toBeInTheDocument()
    expect(screen.getByText("gemini.test")).toBeInTheDocument()
    expect(screen.getByText("hindsight/recall")).toBeInTheDocument()
  })

  it("sends the browser where the server says after Allow", async () => {
    vi.mocked(api.oauth.approve).mockResolvedValue({ redirect: "https://gemini.test/cb?code=C&state=S" })
    const user = userEvent.setup()
    page()
    await user.click(await screen.findByRole("button", { name: "Allow" }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://gemini.test/cb?code=C&state=S"))
    expect(api.oauth.approve).toHaveBeenCalledWith("abc")
  })

  it("says no on Deny", async () => {
    vi.mocked(api.oauth.deny).mockResolvedValue({ redirect: "https://gemini.test/cb?error=access_denied" })
    const user = userEvent.setup()
    page()
    await user.click(await screen.findByRole("button", { name: "Deny" }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://gemini.test/cb?error=access_denied"))
  })

  it("explains an expired request", async () => {
    vi.mocked(api.oauth.request).mockRejectedValue(new ApiError(404, "not found"))
    page()
    expect(await screen.findByText(/expired or was already answered/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument()
  })

  it("needs a request id", async () => {
    page("")
    expect(await screen.findByText(/needs a connection request/)).toBeInTheDocument()
  })
})
