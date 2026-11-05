import { describe, expect, it } from "vitest"
import { revealReducer } from "./Tokens"

describe("revealReducer", () => {
  it("holds the plaintext only between create and close", () => {
    let s = revealReducer(null, { type: "created", token: "cmt_secret", label: "warp" })
    expect(s).toEqual({ token: "cmt_secret", label: "warp" })
    s = revealReducer(s, { type: "close" })
    expect(s).toBeNull()
  })

  it("ignores close when nothing is shown and replaces an older reveal", () => {
    expect(revealReducer(null, { type: "close" })).toBeNull()
    const s = revealReducer({ token: "cmt_old", label: "a" }, { type: "created", token: "cmt_new", label: "b" })
    expect(s).toEqual({ token: "cmt_new", label: "b" })
  })
})
