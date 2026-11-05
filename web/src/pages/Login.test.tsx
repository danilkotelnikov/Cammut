import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>()
  return { ...real, api: { ...real.api, methods: vi.fn(), login: vi.fn(), loginGithub: vi.fn() } }
})

import { api, ApiError } from "../api"
import { AuthContext } from "../auth"
import { cleanCode, explain, Login } from "./Login"

const refresh = vi.fn(async () => {})

function renderLogin(at = "/login") {
  return render(
    <AuthContext.Provider value={{ user: null, refresh, logout: async () => {} }}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/servers" element={<p>servers page</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.methods).mockResolvedValue({ password: true, github: true })
})

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Username"), "alice")
  await user.type(screen.getByLabelText("Password"), "correct horse battery")
  await user.type(screen.getByLabelText(/authenticator or recovery code/i), "123456")
}

describe("Login", () => {
  it("signs in with username, password and code, then opens the servers page", async () => {
    vi.mocked(api.login).mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    renderLogin()
    await fill(user)
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => expect(api.login).toHaveBeenCalledWith("alice", "correct horse battery", "123456"))
    await screen.findByText("servers page")
    expect(refresh).toHaveBeenCalled()
  })

  it("finishes a GitHub sign-in that needs no code by reloading the user and leaving the page", async () => {
    renderLogin("/login?github=done")
    await screen.findByText("servers page")
    expect(refresh).toHaveBeenCalled()
  })

  it("sends a code typed with a space, as the app shows it, as six digits", async () => {
    vi.mocked(api.login).mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    renderLogin()
    await user.type(await screen.findByLabelText("Username"), "alice")
    await user.type(screen.getByLabelText("Password"), "correct horse battery")
    await user.type(screen.getByLabelText(/authenticator or recovery code/i), " 123 456 ")
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => expect(api.login).toHaveBeenCalledWith("alice", "correct horse battery", "123456"))
  })

  it("cleans codes: digits lose their spaces, a recovery code is only trimmed", () => {
    expect(cleanCode("123 456")).toBe("123456")
    expect(cleanCode("  654321 ")).toBe("654321")
    expect(cleanCode(" ABCDE-FGHJK ")).toBe("ABCDE-FGHJK")
    expect(cleanCode("abcde fghjk")).toBe("abcde fghjk")
  })

  it("explains a wrong login and clears only the code", async () => {
    vi.mocked(api.login).mockRejectedValue(new ApiError(401, "invalid credentials"))
    const user = userEvent.setup()
    renderLogin()
    await fill(user)
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    await screen.findByText("Wrong username, password or code.")
    expect(screen.getByLabelText(/authenticator or recovery code/i)).toHaveValue("")
    expect(screen.getByLabelText("Username")).toHaveValue("alice")
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled()
  })

  it("offers GitHub only when it is configured", async () => {
    renderLogin()
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute("href", "/auth/github/start")
  })

  it("shows only the GitHub button when the password form is off and GitHub is on", async () => {
    vi.mocked(api.methods).mockResolvedValue({ password: false, github: true })
    renderLogin()
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute("href", "/auth/github/start")
    expect(screen.queryByLabelText(/password/i)).toBeNull()
    expect(screen.queryByText(/switched off/i)).toBeNull()
  })

  it("says how to get in when password login is off on this address", async () => {
    vi.mocked(api.methods).mockResolvedValue({ password: false, github: false })
    renderLogin()
    expect(await screen.findByText(/switched off on this address/i)).toBeInTheDocument()
    expect(screen.getByText(/owner-only access/i)).toBeInTheDocument()
    expect(screen.getByText(/cammut\.localhost:7422\/console\//)).toBeInTheDocument()
    expect(screen.getByText("-public-login")).toBeInTheDocument()
    expect(screen.getByText("-public-login-github-only")).toBeInTheDocument()
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
  })

  it("shows only the code box after GitHub confirmed the identity", async () => {
    vi.mocked(api.loginGithub).mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    renderLogin("/login?github=1")
    await user.type(await screen.findByLabelText(/authenticator or recovery code/i), "654321")
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Finish sign-in" }))
    await waitFor(() => expect(api.loginGithub).toHaveBeenCalledWith("654321"))
  })

  it("reports a failed GitHub round trip", async () => {
    renderLogin("/login?error=github")
    expect(await screen.findByText(/GitHub sign-in did not work/i)).toBeInTheDocument()
  })

  it("does not present a failed method lookup as intentionally disabled login", async () => {
    vi.mocked(api.methods).mockRejectedValue(new ApiError(0, "Could not reach the server."))
    renderLogin()
    expect(await screen.findByText(/could not check how to sign in/i)).toBeInTheDocument()
    expect(screen.queryByText(/switched off on this address/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
  })
})

describe("explain", () => {
  it("maps statuses to readable text", () => {
    expect(explain(new ApiError(429, "x", 61))).toBe("Too many attempts. Try again in 61 s.")
    expect(explain(new ApiError(429, "x"))).toBe("Too many attempts. Try again in 60 s.")
    expect(explain(new ApiError(503, "x"))).toMatch(/busy/i)
    expect(explain(new ApiError(404, "x"))).toMatch(/switched off/i)
    expect(explain(new ApiError(400, "bad thing"))).toBe("bad thing")
    expect(explain(new ApiError(0, "Could not reach the server."))).toBe("Could not reach the server.")
    expect(explain(new Error("boom"))).toBe("Could not reach the server.")
  })
})
