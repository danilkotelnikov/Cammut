import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api, ApiError, setOnUnauthorized } from "./api"

type FetchInit = RequestInit & { headers: Record<string, string> }

function mockFetch(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(async (_url: string, _init: FetchInit) => {
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)
    return new Response(status === 204 ? null : text, { status, headers })
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

beforeEach(() => setOnUnauthorized(() => {}))
afterEach(() => vi.unstubAllGlobals())

describe("request plumbing", () => {
  it("sends the CSRF header on every call and JSON content type only with a body", async () => {
    const f = mockFetch(200, [])
    await api.upstreams.list()
    expect(f.mock.calls[0][0]).toBe("/api/v1/upstreams")
    expect(f.mock.calls[0][1].headers["X-Requested-With"]).toBe("cammut")
    expect(f.mock.calls[0][1].headers["Content-Type"]).toBeUndefined()

    const g = mockFetch(201, { name: "gh" })
    await api.upstreams.add({ name: "gh", url: "https://x.example/mcp" })
    const init = g.mock.calls[0][1]
    expect(init.method).toBe("POST")
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(init.credentials).toBe("same-origin")
    expect(JSON.parse(init.body as string)).toEqual({ name: "gh", url: "https://x.example/mcp" })
  })

  it("encodes path parameters", async () => {
    const f = mockFetch(204)
    await api.tokens.revoke("a/b c")
    expect(f.mock.calls[0][0]).toBe("/api/v1/tokens/a%2Fb%20c")
    expect(f.mock.calls[0][1].method).toBe("DELETE")
  })

  it("returns undefined for 204 and parsed JSON otherwise", async () => {
    mockFetch(204)
    expect(await api.secrets.remove("X")).toBeUndefined()
    mockFetch(200, { username: "alice", github_linked: false, site_origin: "https://cammut.example" })
    expect(await api.me()).toEqual({ username: "alice", github_linked: false, site_origin: "https://cammut.example" })
  })

  it("turns failures into ApiError with the server's message and Retry-After", async () => {
    mockFetch(429, { error: "too many attempts" }, { "Retry-After": "61" })
    await expect(api.login("a", "b", "c")).rejects.toMatchObject({ status: 429, message: "too many attempts", retryAfter: 61 })
    mockFetch(500, "<html>boom</html>")
    const err = await api.upstreams.list().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(500)
    expect(String(err.message)).not.toContain("<html>")
  })

  it("calls the unauthorized hook on 401 except for the login endpoints", async () => {
    const hook = vi.fn()
    setOnUnauthorized(hook)
    mockFetch(401, { error: "login required" })
    await api.tokens.list().catch(() => {})
    expect(hook).toHaveBeenCalledTimes(1)
    mockFetch(401, { error: "invalid credentials" })
    await api.login("a", "b", "c").catch(() => {})
    await api.loginGithub("123456").catch(() => {})
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it("builds the audit query string from the set filters only", async () => {
    const f = mockFetch(200, [])
    await api.audit({ upstream: "alpha", tool: "", ok: "false", offset: 50, limit: 50 })
    expect(f.mock.calls[0][0]).toBe("/api/v1/audit?upstream=alpha&ok=false&limit=50&offset=50")
  })

  it("never puts a secret value into the URL", async () => {
    const f = mockFetch(204)
    await api.secrets.put("GH_PAT", "github_pat_VALUE")
    expect(f.mock.calls[0][0]).toBe("/api/v1/secrets/GH_PAT")
    expect(f.mock.calls[0][0]).not.toContain("VALUE")
    expect(f.mock.calls[0][1].method).toBe("PUT")
  })
})
