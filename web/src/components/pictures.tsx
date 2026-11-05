import { useEffect, useMemo, useState, type ReactNode } from "react"
import { layers } from "./park.js"
import { forest, lake, sea } from "./scenes"
import type { Palette } from "./palettes"

// The three background pictures, each in the colours of the chosen palette.
//   cubes  - the v0 isometric cube pattern (dots, checks, solid faces, grain), laid out again on every shuffle
//   colour - soft colour clouds that drift slowly, with a faint sun
//   park   - a painted park: sky, sun, clouds, three hill layers with a treeline, mist and wave lines
// The cube pattern follows the generator on v0 (https://v0-isometric-cube-pattern.vercel.app/): three faces per cube,
// each with its own colour from the preset and its own pattern, a pattern ink taken from the other end of the palette,
// and a grain over the whole field. The code is our own, written from how that page behaves.

export type PictureProps = { palette: Palette; layout: number }
export type Picture = { name: string; label: string; Art: (p: PictureProps) => ReactNode }

// ---- the cube pattern ------------------------------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type CubeConfig = { size: number; dots: boolean; checker: boolean; solid: boolean; noise: boolean; grain: number }
export const DEFAULT_LAYOUT = 20261019
export const DEFAULT_CUBES: CubeConfig = { size: 60, dots: true, checker: true, solid: true, noise: true, grain: 0.6 }

/** What "randomize" does on the v0 page: a new cube size, a new mix of patterns and a new grain. */
export function cubeConfig(layout: number): CubeConfig {
  if (layout === DEFAULT_LAYOUT) return DEFAULT_CUBES
  const r = rng(layout)
  const size = Math.floor(r() * 60) + 40
  let dots = r() > 0.3
  let checker = r() > 0.3
  let solid = r() > 0.2
  if (!dots && !checker && !solid) {
    const k = Math.floor(r() * 3)
    dots = k === 0
    checker = k === 1
    solid = k === 2
  }
  return { size, dots, checker, solid, noise: r() > 0.3, grain: Math.round((r() * 1.2 + 0.2) * 10) / 10 }
}

type Face = { colour: string; kind: "dots" | "checker" | "solid"; ink: string }
export type FieldCube = { x: number; y: number; faces: [Face, Face, Face] } // top, left, right

// Pattern ink: a face that is one of the four light colours gets the fourth colour of the palette, any other face gets the lightest.
const inkFor = (colour: string, colours: string[]) => (colours.slice(-4).includes(colour) ? colours[3] ?? colours[0] : colours[colours.length - 1])

export function dealCubes(colours: string[], width: number, height: number, cfg: CubeConfig, layout: number): FieldCube[] {
  const r = rng(layout)
  const kinds: Face["kind"][] = []
  if (cfg.dots) kinds.push("dots")
  if (cfg.checker) kinds.push("checker")
  if (cfg.solid) kinds.push("solid", "solid")
  if (kinds.length === 0) kinds.push("solid")
  const n = cfg.size
  const o = (n * Math.sqrt(3)) / 2
  const step = 1.5 * n
  const w = 2 * o
  const cols = Math.ceil(width / w) + 4
  const rows = Math.ceil(height / step) + 4
  const face = (): Face => {
    const colour = colours[Math.floor(r() * colours.length)]
    return { colour, kind: kinds[Math.floor(r() * kinds.length)], ink: inkFor(colour, colours) }
  }
  const out: FieldCube[] = []
  for (let row = -3; row < rows; row++) {
    for (let col = -2; col < cols; col++) {
      out.push({ x: w * col + (row % 2 === 1 ? o : 0) + o, y: step * row + 2 * n, faces: [face(), face(), face()] })
    }
  }
  return out
}

// each face lies in its own plane, so its pattern is skewed into that plane
const MATRIX = ["matrix(1, 0.5, -1, 0.5, 0, 0)", "matrix(1, 0.5, 0, 1, 0, 0)", "matrix(1, -0.5, 0, 1, 0, 0)"]
const FACE_NAME = ["top", "left", "right"]
const patternId = (f: number, face: Face) => `cmp-${FACE_NAME[f]}-${face.kind}-${face.colour.slice(1)}-${face.ink.slice(1)}`

function CubeField({ palette, layout, width, height }: { palette: Palette; layout: number; width: number; height: number }) {
  const cfg = useMemo(() => cubeConfig(layout), [layout])
  const cubes = useMemo(() => dealCubes(palette.cubes, width, height, cfg, layout), [palette, width, height, cfg, layout])
  // one definition per distinct face look, shared by every cube that uses it
  const defs = useMemo(() => {
    const seen = new Map<string, ReactNode>()
    for (const c of cubes) {
      c.faces.forEach((face, f) => {
        if (face.kind === "solid") return
        const id = patternId(f, face)
        if (seen.has(id)) return
        seen.set(
          id,
          <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="20" height="20" patternTransform={MATRIX[f]}>
            {face.kind === "dots" ? (
              <ellipse cx="10" cy="10" rx="6" ry="6" fill={face.ink} />
            ) : (
              <>
                <rect width="20" height="20" fill={face.colour} />
                <rect x="0" y="0" width="10" height="10" fill={face.ink} />
                <rect x="10" y="10" width="10" height="10" fill={face.ink} />
              </>
            )}
          </pattern>,
        )
      })
    }
    return [...seen.values()]
  }, [cubes])
  const n = cfg.size
  const o = (n * Math.sqrt(3)) / 2
  return (
    <svg className="absolute inset-0 h-full w-full" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid slice" data-testid="pic-cubes" aria-hidden="true">
      <defs>
        {defs}
        <filter id="cmp-grain">
          <feTurbulence type="fractalNoise" baseFrequency={cfg.grain} numOctaves="4" result="noise" />
          <feColorMatrix type="saturate" values="0" />
          <feBlend in="SourceGraphic" in2="noise" mode="multiply" />
        </filter>
      </defs>
      <g style={cfg.noise ? { filter: "url(#cmp-grain)" } : undefined}>
        {cubes.map((c, i) => {
          const polys = [
            `${c.x},${c.y - n} ${c.x + o},${c.y - n / 2} ${c.x},${c.y} ${c.x - o},${c.y - n / 2}`,
            `${c.x - o},${c.y - n / 2} ${c.x},${c.y} ${c.x},${c.y + n} ${c.x - o},${c.y + n / 2}`,
            `${c.x},${c.y} ${c.x + o},${c.y - n / 2} ${c.x + o},${c.y + n / 2} ${c.x},${c.y + n}`,
          ]
          return (
            <g key={i}>
              {c.faces.map((face, f) => (
                <g key={f}>
                  <polygon points={polys[f]} fill={face.colour} />
                  {face.kind !== "solid" ? <polygon points={polys[f]} fill={`url(#${patternId(f, face)})`} /> : null}
                </g>
              ))}
            </g>
          )
        })}
      </g>
    </svg>
  )
}

// ---- soft colour -----------------------------------------------------------------------------------------------------
function Colour() {
  return (
    <div className="pk-sky absolute inset-0" data-testid="pic-colour">
      <div className="pk-mesh">
        <i className="pk-m1" />
        <i className="pk-m2" />
        <i className="pk-m3" />
      </div>
      <div className="pk-sun">
        <i className="pk-rays" />
      </div>
    </div>
  )
}

// ---- park ------------------------------------------------------------------------------------------------------------
const PARK = layers()
function Park() {
  return (
    <div className="pk-sky absolute inset-0" data-testid="pic-park">
      <div className="pk-mesh">
        <i className="pk-m1" />
        <i className="pk-m2" />
        <i className="pk-m3" />
      </div>
      <div className="pk-sun">
        <i className="pk-rays" />
      </div>
      <div className="pk-lay pk-clouds-wrap">
        <div className="pk-clouds" dangerouslySetInnerHTML={{ __html: PARK.clouds + PARK.clouds }} />
      </div>
      <div className="pk-park">
        <div className="pk-lay pk-hills pk-far" dangerouslySetInnerHTML={{ __html: PARK.far }} />
        <div className="pk-lay pk-mist">
          <i />
        </div>
        <div className="pk-lay pk-hills pk-mid" dangerouslySetInnerHTML={{ __html: PARK.mid }} />
        <div className="pk-lay pk-hills pk-near" dangerouslySetInnerHTML={{ __html: PARK.near }} />
        <div className="pk-waves" dangerouslySetInnerHTML={{ __html: '<div class="pk-wv">' + PARK.waves + PARK.waves + "</div>" }} />
      </div>
    </div>
  )
}

// ---- forest, sea and lake: flat, aligned landscapes (see scenes.ts) --------------------------------------------------
function Scenic({ testId, parts }: { testId: string; parts: string[] }) {
  return (
    <div className="pk-sky absolute inset-0" data-testid={testId}>
      <div className="pk-mesh">
        <i className="pk-m1" />
        <i className="pk-m2" />
        <i className="pk-m3" />
      </div>
      <div className="pk-lay pk-clouds-wrap">
        <div className="pk-clouds" dangerouslySetInnerHTML={{ __html: PARK.clouds + PARK.clouds }} />
      </div>
      <div className="pk-art" dangerouslySetInnerHTML={{ __html: parts.join("") }} />
    </div>
  )
}
const FOREST = forest()
const SEA = sea()
const LAKE = lake()

export const PICTURES: Picture[] = [
  { name: "cubes", label: "Cubes", Art: ({ palette, layout }) => <CubeFieldSized palette={palette} layout={layout} /> },
  { name: "colour", label: "Colour", Art: () => <Colour /> },
  { name: "park", label: "Park", Art: () => <Park /> },
  { name: "forest", label: "Forest", Art: () => <Scenic testId="pic-forest" parts={[FOREST.sun, FOREST.far, FOREST.mid, FOREST.near]} /> },
  { name: "sea", label: "Sea", Art: () => <Scenic testId="pic-sea" parts={[SEA.sun, SEA.water, SEA.waves, SEA.land]} /> },
  { name: "lake", label: "Lake", Art: () => <Scenic testId="pic-lake" parts={[LAKE.sun, LAKE.mountains, LAKE.water, LAKE.shore]} /> },
]

export const DEFAULT_PICTURE = "cubes"

// The cube field needs the window size; read it here so the other pictures stay free of it.
function useWindowSize() {
  const [size, setSize] = useState({ width: typeof window === "undefined" ? 1440 : window.innerWidth, height: typeof window === "undefined" ? 900 : window.innerHeight })
  useEffect(() => {
    const on = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener("resize", on)
    return () => window.removeEventListener("resize", on)
  }, [])
  return size
}
function CubeFieldSized({ palette, layout }: PictureProps) {
  const { width, height } = useWindowSize()
  return <CubeField palette={palette} layout={layout} width={width} height={height} />
}
