import { describe, expect, it } from "vitest"
import { BOX, forest, lake, sea } from "./scenes"
import { LOOK_D_LIGHT } from "./lookD"

const all = { forest: forest(), sea: sea(), lake: lake() }
const names = Object.keys(LOOK_D_LIGHT).map((k) => k.slice(2))

describe("scenes", () => {
  it("draw every layer in the same 1600 x 620 box, anchored to the bottom", () => {
    expect(BOX).toEqual({ W: 1600, H: 620 })
    for (const [scene, layers] of Object.entries(all)) {
      for (const [layer, svg] of Object.entries(layers)) {
        expect(svg, `${scene}.${layer}`).toContain("viewBox='0 0 1600 620'")
        expect(svg, `${scene}.${layer}`).toContain("preserveAspectRatio='xMidYMax slice'")
      }
    }
  })

  it("take every colour from the palette variables, never a fixed colour", () => {
    for (const [scene, layers] of Object.entries(all)) {
      for (const [layer, svg] of Object.entries(layers)) {
        expect(svg, `${scene}.${layer} has a fixed colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
        for (const m of svg.matchAll(/var\(--([a-z0-9-]+)\)/g)) expect(names, `${scene}.${layer} uses --${m[1]}`).toContain(m[1])
      }
    }
  })

  it("keep every tag closed", () => {
    for (const layers of Object.values(all)) {
      for (const svg of Object.values(layers)) {
        const opens = (svg.match(/<(svg|g|defs|clipPath|linearGradient|radialGradient|filter)\b/g) ?? []).length
        const closes = (svg.match(/<\/(svg|g|defs|clipPath|linearGradient|radialGradient|filter)>/g) ?? []).length
        expect(opens).toBe(closes)
      }
    }
  })

  it("put the sea and the lake on one horizon: the lake is mirrored about its waterline", () => {
    expect(all.lake.water).toContain("translate(0 660) scale(1 -1)")
    expect(all.sea.water).toContain("translate(0 632) scale(1 -1)")
  })
})
