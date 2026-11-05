import { describe, expect, it } from "vitest"
import { formatTime, parseScopes, relativeTime, scopeProblem, secretNameFor, tokenState } from "./format"

describe("parseScopes", () => {
  it("splits on commas, spaces and newlines, trims, drops empties and duplicates", () => {
    expect(parseScopes("github/*, hindsight/recall\nopenviking/find  github/*,")).toEqual(["github/*", "hindsight/recall", "openviking/find"])
    expect(parseScopes("")).toEqual([])
    expect(parseScopes(" , \n ")).toEqual([])
  })
})

describe("scopeProblem", () => {
  it("accepts the server's scope alphabet and names the first bad scope", () => {
    expect(scopeProblem(["*", "github/*", "a.b_c-d/e*"])).toBeNull()
    expect(scopeProblem(["github/*", "bad scope!"])).toContain("bad scope!")
    expect(scopeProblem(["x".repeat(81)])).toContain("80")
  })
})

describe("tokenState", () => {
  const now = new Date("2026-10-10T12:00:00Z")
  it("tells revoked, expired and active apart", () => {
    expect(tokenState({ revoked: true, expires_at: null }, now)).toBe("revoked")
    expect(tokenState({ revoked: false, expires_at: "2026-10-10T11:00:00Z" }, now)).toBe("expired")
    expect(tokenState({ revoked: false, expires_at: "2026-10-11T11:00:00Z" }, now)).toBe("active")
    expect(tokenState({ revoked: false, expires_at: null }, now)).toBe("active")
    expect(tokenState({ revoked: true, expires_at: "2026-10-10T11:00:00Z" }, now)).toBe("revoked")
  })
})

describe("time helpers", () => {
  const now = new Date("2026-10-10T12:00:00Z")
  it("formats relative times", () => {
    expect(relativeTime(null, now)).toBe("never")
    expect(relativeTime("2026-10-10T11:59:40Z", now)).toBe("just now")
    expect(relativeTime("2026-10-10T11:30:00Z", now)).toBe("30 min ago")
    expect(relativeTime("2026-10-10T07:00:00Z", now)).toBe("5 h ago")
    expect(relativeTime("2026-10-07T12:00:00Z", now)).toBe("3 d ago")
    expect(relativeTime("2026-10-10T13:00:00Z", now)).toBe("in 1 h")
  })
  it("formats absolute times and tolerates junk", () => {
    expect(formatTime(null)).toBe("")
    expect(formatTime("not a date")).toBe("not a date")
    expect(formatTime("2026-10-10T12:00:00Z")).toMatch(/2026/)
  })
})

describe("secretNameFor", () => {
  it("suggests an upper-case secret name from an upstream name", () => {
    expect(secretNameFor("github")).toBe("GITHUB_TOKEN")
    expect(secretNameFor("open-viking")).toBe("OPEN_VIKING_TOKEN")
    expect(secretNameFor("9lives")).toBe("_9LIVES_TOKEN")
  })
})
