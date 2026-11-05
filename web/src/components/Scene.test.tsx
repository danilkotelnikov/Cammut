import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { CubeCluster } from "./CubeCluster"
import { LOOK_D_LIGHT } from "./lookD"
import { clusterVars, PALETTES, pictureVars } from "./palettes"
import { cubeConfig, DEFAULT_CUBES, DEFAULT_LAYOUT, dealCubes, PICTURES } from "./pictures"
import { nextPalette, nextPicture, PICTURE_EVENT, Scene, SHUFFLE_EVENT, setLayout, setPalette, setPicture } from "./Scene"

const attr = (c: HTMLElement, name: string) => c.querySelector(".cm-sky")!.getAttribute(name)
const lumaOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((s, v, i) => s + v * [0.299, 0.587, 0.114][i], 0) / 255

beforeEach(() =>
  act(() => {
    setPalette("mono")
    setPicture("cubes")
    setLayout(DEFAULT_LAYOUT)
  }),
)

describe("palettes", () => {
  it("has nine colours in every palette, starting with black and white", () => {
    expect(PALETTES[0].name).toBe("mono")
    for (const p of PALETTES) {
      expect(p.cubes).toHaveLength(9)
      for (const c of p.cubes) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  it("gives the Original palette the scene colours untouched and recolours the others", () => {
    const original = PALETTES.find((p) => p.name === "original")!
    expect(pictureVars(original, "light")).toEqual(LOOK_D_LIGHT)
    const mono = pictureVars(PALETTES[0], "light")
    for (const k of ["--v-sk0", "--v-sk1", "--p-far", "--p-near", "--v-haze"]) {
      const h = mono[k]
      expect(h.slice(1, 3) === h.slice(3, 5) && h.slice(3, 5) === h.slice(5, 7), `${k} ${h} is grey`).toBe(true)
    }
  })

  it("keeps the tone order of the scene and the alpha of the translucent colours", () => {
    for (const p of PALETTES) {
      const v = pictureVars(p, "light")
      expect(lumaOf(v["--p-far-hi"])).toBeGreaterThan(lumaOf(v["--p-near"]))
      expect(v["--v-mist"]).toMatch(/^rgba\(\d+, \d+, \d+, 0\.62\)$/)
    }
  })

  it("moves to a different palette and picture every time", () => {
    for (const p of PALETTES) for (const r of [0, 0.4, 0.999]) expect(nextPalette(p.name, r)).not.toBe(p.name)
    for (const p of PICTURES) for (const r of [0, 0.5, 0.999]) expect(nextPicture(p.name, r)).not.toBe(p.name)
  })

  it("gives the seven-cube mark its four colours", () => {
    const v = clusterVars(PALETTES[1], "dark")
    for (const k of ["--cl-c", "--cl-1", "--cl-2", "--cl-3", "--cl-top", "--cl-right"]) expect(v[k]).toBeTruthy()
  })
})

describe("the cube pattern", () => {
  it("uses the v0 defaults first and a new mix after a shuffle", () => {
    expect(cubeConfig(DEFAULT_LAYOUT)).toEqual(DEFAULT_CUBES)
    const c = cubeConfig(12345)
    expect(c.size).toBeGreaterThanOrEqual(40)
    expect(c.size).toBeLessThan(100)
    expect(c.dots || c.checker || c.solid).toBe(true)
  })

  it("deals the same cubes for the same layout, with palette colours and only the patterns that are on", () => {
    const colours = PALETTES[1].cubes
    const a = dealCubes(colours, 1200, 800, DEFAULT_CUBES, 7)
    expect(a).toEqual(dealCubes(colours, 1200, 800, DEFAULT_CUBES, 7))
    expect(a).not.toEqual(dealCubes(colours, 1200, 800, DEFAULT_CUBES, 8))
    expect(a.length).toBeGreaterThan(100)
    const solidOnly = dealCubes(colours, 600, 400, { ...DEFAULT_CUBES, dots: false, checker: false }, 3)
    for (const c of solidOnly) for (const f of c.faces) expect(colours).toContain(f.colour)
    for (const c of solidOnly) for (const f of c.faces) expect(f.kind).toBe("solid")
  })

  it("draws a pattern ink that reads on the face: light faces get a dark ink, others the lightest colour", () => {
    const colours = PALETTES[1].cubes
    for (const c of dealCubes(colours, 800, 600, DEFAULT_CUBES, 11)) {
      for (const f of c.faces) expect(f.ink).toBe(colours.slice(-4).includes(f.colour) ? colours[3] : colours[8])
    }
  })
})

describe("Scene", () => {
  it("starts with the cube pattern in black and white", () => {
    const { container } = render(<Scene />)
    expect(attr(container, "data-palette")).toBe("mono")
    expect(attr(container, "data-picture")).toBe("cubes")
    expect(screen.getByTestId("pic-cubes")).toBeInTheDocument()
  })

  it("randomises on Space: a new palette and a new layout", () => {
    const { container } = render(<Scene />)
    fireEvent.keyDown(window, { code: "Space", key: " " })
    expect(attr(container, "data-palette")).not.toBe("mono")
    expect(attr(container, "data-layout")).not.toBe(String(DEFAULT_LAYOUT))
    expect(localStorage.getItem("cammut-palette")).toBe(attr(container, "data-palette"))
  })

  it("brings another picture on P and from its chip, keeping the palette", () => {
    const { container } = render(<Scene />)
    fireEvent.keyDown(window, { code: "KeyP", key: "p" })
    const first = attr(container, "data-picture")!
    expect(first).not.toBe("cubes")
    expect(screen.getByTestId(`pic-${first}`)).toBeInTheDocument()
    expect(attr(container, "data-palette")).toBe("mono")
    fireEvent.click(screen.getByRole("button", { name: "Change the picture" }))
    expect(attr(container, "data-picture")).not.toBe(first)
    expect(localStorage.getItem("cammut-picture")).toBe(attr(container, "data-picture"))
  })

  it("shows every picture", () => {
    for (const p of PICTURES) {
      act(() => setPicture(p.name))
      const { unmount } = render(<Scene />)
      expect(screen.getByTestId(`pic-${p.name}`)).toBeInTheDocument()
      unmount()
    }
  })

  it("restyles from the chip", () => {
    const { container } = render(<Scene />)
    fireEvent.click(screen.getByRole("button", { name: "Change the palette" }))
    expect(attr(container, "data-palette")).not.toBe("mono")
  })

  it("leaves Space and P alone while typing in a field and with a modifier", () => {
    const { container } = render(
      <>
        <Scene />
        <input aria-label="name" />
      </>,
    )
    fireEvent.keyDown(screen.getByLabelText("name"), { code: "Space", key: " " })
    fireEvent.keyDown(screen.getByLabelText("name"), { code: "KeyP", key: "p" })
    fireEvent.keyDown(window, { code: "Space", key: " ", ctrlKey: true })
    expect(attr(container, "data-palette")).toBe("mono")
    expect(attr(container, "data-picture")).toBe("cubes")
  })

  it("inside the app the picture is faint, the keys do nothing and the Ctrl+K events work", () => {
    const { container } = render(<Scene variant="quiet" />)
    expect(screen.queryByRole("button", { name: "Change the palette" })).toBeNull()
    fireEvent.keyDown(window, { code: "Space", key: " " })
    fireEvent.keyDown(window, { code: "KeyP", key: "p" })
    expect(attr(container, "data-palette")).toBe("mono")
    expect(attr(container, "data-picture")).toBe("cubes")
    act(() => void window.dispatchEvent(new Event(SHUFFLE_EVENT)))
    expect(attr(container, "data-palette")).not.toBe("mono")
    act(() => void window.dispatchEvent(new Event(PICTURE_EVENT)))
    expect(attr(container, "data-picture")).not.toBe("cubes")
  })
})

describe("CubeCluster", () => {
  it("draws seven cubes", () => {
    render(<CubeCluster />)
    expect(screen.getAllByTestId("cube")).toHaveLength(7)
  })
})
