import { LOOK_D_DARK, LOOK_D_LIGHT } from "./lookD"

// Palettes for the background pictures. Every palette is nine colours, in the order the v0 isometric generator keeps them:
// the first five are the strong colours and the last four are the light ones (the generator draws the pattern ink from them).
// "original" is the v0 preset "Original"; "mono" is the v0 "Monochrome" preset with the blue tint taken out, so it is pure grey. The page panels and the text stay black and white;
// only the pictures and the seven-cube mark take the palette.
export type Theme = "light" | "dark"
export type Palette = { name: string; label: string; cubes: string[] }

export const PALETTES: Palette[] = [
  { name: "mono", label: "Black and white", cubes: ["#141414", "#262626", "#3D3D3D", "#525252", "#737373", "#A3A3A3", "#D4D4D4", "#E5E5E5", "#FAFAFA"] },
  { name: "original", label: "Original", cubes: ["#E87BA1", "#F5A5C0", "#5B8BD4", "#1E2A5E", "#6B4C7A", "#4A3459", "#8B8B9E", "#C4C4D4", "#F0F0F5"] },
  { name: "dusk", label: "Dusk", cubes: ["#5B8BD4", "#3A4F96", "#1E2A5E", "#6B4C7A", "#31295C", "#8B8B9E", "#B7C7E6", "#A89272", "#EFE8D8"] },
  { name: "dawn", label: "Dawn", cubes: ["#C88A86", "#B9966F", "#8F6A76", "#A8776F", "#7A4B52", "#D7B8B0", "#E8D5D3", "#EFCF9F", "#F6E3C8"] },
  { name: "sage", label: "Sage", cubes: ["#5F8F86", "#7A9A76", "#3E6770", "#2A5A58", "#6F9488", "#93B0A4", "#C9D8D2", "#E6DFB9", "#F0F2E8"] },
]

export const DEFAULT_PALETTE = "mono"

// ---- colour helpers --------------------------------------------------------------------------------------------------
type RGB = [number, number, number]
const hexRgb = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB
const rgbHex = (c: RGB) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")
const luma = (c: RGB) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255
const mixRgb = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]

function parse(v: string): { rgb: RGB; a: number | null } | null {
  if (v.startsWith("#") && v.length === 7) return { rgb: hexRgb(v), a: null }
  const m = v.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/)
  return m ? { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: Number(m[4]) } : null
}

/** The nine colours of a palette as a ramp from dark to light; `at(0)` is the darkest, `at(1)` the lightest. */
function ramp(p: Palette): (t: number) => RGB {
  const sorted = p.cubes.map(hexRgb).sort((a, b) => luma(a) - luma(b))
  return (t) => {
    const x = Math.max(0, Math.min(1, t)) * (sorted.length - 1)
    const i = Math.min(sorted.length - 2, Math.floor(x))
    return mixRgb(sorted[i], sorted[i + 1], x - i)
  }
}

/**
 * The colours of the soft landscape (look D) for one palette and theme. The tables are drawn in the Original colours; any
 * other palette recolours them by luminance, so a dark colour stays dark and a light one stays light, and the scene keeps
 * its structure in every palette. Alpha is kept.
 */
export function pictureVars(p: Palette, theme: Theme): Record<string, string> {
  const table = theme === "dark" ? LOOK_D_DARK : LOOK_D_LIGHT
  const out: Record<string, string> = { ...table }
  if (p.name !== "original") {
    const parsed = Object.entries(table).map(([k, v]) => [k, parse(v)] as const)
    const ls = parsed.flatMap(([, c]) => (c ? [luma(c.rgb)] : []))
    const lo = Math.min(...ls)
    const hi = Math.max(...ls)
    const at = ramp(p)
    for (const [k, c] of parsed) {
      if (!c) continue
      let t = (luma(c.rgb) - lo) / (hi - lo || 1)
      t = t + 0.5 * (t * t * (3 - 2 * t) - t) // a gentle S-curve spreads the tones
      if (theme === "dark" && /^--p-(far|mid|near|tree)/.test(k)) t -= 0.16 // on a dark sky the hills sit below it, so they stay apart
      const mapped = at(t)
      out[k] = c.a === null ? rgbHex(mapped) : `rgba(${Math.round(mapped[0])}, ${Math.round(mapped[1])}, ${Math.round(mapped[2])}, ${c.a})`
    }
  }
  return out
}

/** The four colours of the seven-cube mark: the lightest colour in the middle, three strong colours around it. */
export function clusterVars(p: Palette, theme: Theme): Record<string, string> {
  const [c0, , c2, , c4] = p.cubes
  return {
    "--cl-c": p.cubes[8],
    "--cl-1": c0,
    "--cl-2": c2,
    "--cl-3": c4,
    "--cl-top": theme === "dark" ? "rgb(255 255 255 / 0.2)" : "rgb(255 255 255 / 0.3)",
    "--cl-right": theme === "dark" ? "rgb(0 0 0 / 0.4)" : "rgb(0 0 0 / 0.26)",
    "--cl-edge": theme === "dark" ? "rgb(255 255 255 / 0.55)" : "rgb(0 0 0 / 0.5)", // a thin outline round every face, so the mark reads on any picture
  }
}

/** Everything a picture or the mark may read, for the chosen palette and theme. */
export function paletteVars(p: Palette, theme: Theme): Record<string, string> {
  return { ...pictureVars(p, theme), ...clusterVars(p, theme) }
}
