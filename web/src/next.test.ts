import { beforeEach, describe, expect, it } from "vitest"
import { rememberNext, takeNext } from "./next"

beforeEach(() => sessionStorage.clear())

describe("next", () => {
  it("lands on the start page when nothing was remembered", () => {
    expect(takeNext()).toBe("/servers")
  })

  it("remembers a console path once", () => {
    rememberNext("/oauth?req=abc")
    expect(takeNext()).toBe("/oauth?req=abc")
    expect(takeNext()).toBe("/servers")
  })

  it("never remembers the start pages or an address that leaves the console", () => {
    rememberNext("/servers")
    expect(takeNext()).toBe("/servers")
    rememberNext("//evil.test/x")
    expect(takeNext()).toBe("/servers")
    sessionStorage.setItem("cammut-next", "https://evil.test/x")
    expect(takeNext()).toBe("/servers")
  })
})
