// Three flat, quiet landscapes in the manner of an indie game poster: Forest, Sea and Lake. Each one is a handful of layers
// of simple shapes, aligned on a single horizon, drawn only with the palette variables (--v-* and --p-*, see palettes.ts), so
// every scene works in every palette and in light and dark. Everything is built in a 1600 x 620 box that is anchored to the
// bottom of the window; the horizon is the same line for every layer, so nothing drifts out of line when the window changes.
// Each layer is its own <svg> so the page can move it a few pixels. All shapes come from a seeded generator and fixed numbers.

export const BOX = { W: 1600, H: 620 }
const { W, H } = BOX
const f = (n: number) => (Math.round(n * 10) / 10).toString()
const fl = (name: string, opacity?: number) => `style='fill:var(--${name})${opacity != null ? `;fill-opacity:${opacity}` : ""}'`
const stroke = (name: string, width: number, opacity?: number) => `style='stroke:var(--${name});stroke-width:${width}${opacity != null ? `;stroke-opacity:${opacity}` : ""}' fill='none' stroke-linecap='round'`
const stop = (offset: number, name: string, opacity?: number) => `<stop offset='${offset}' style='stop-color:var(--${name})${opacity != null ? `;stop-opacity:${opacity}` : ""}'/>`
const lin = (id: string, y1: number, y2: number, stops: string[]) => `<linearGradient id='${id}' gradientUnits='userSpaceOnUse' x1='0' y1='${y1}' x2='0' y2='${y2}'>${stops.join("")}</linearGradient>`
const radial = (id: string, cx: number, cy: number, r: number, stops: string[]) => `<radialGradient id='${id}' gradientUnits='userSpaceOnUse' cx='${cx}' cy='${cy}' r='${r}'>${stops.join("")}</radialGradient>`
const layer = (inner: string, cls: string, extra = "") =>
  `<svg class='pk-lay ${cls}' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='xMidYMax slice' aria-hidden='true' focusable='false' style='overflow:visible' ${extra}>${inner}</svg>`

type Pt = [number, number]

// A smooth line through the points (Catmull-Rom as cubic curves), closed down past the bottom edge so no seam shows.
function ground(pts: Pt[], bottom = H + 40): string {
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`
  }
  const last = pts[pts.length - 1]
  return `${d}L${f(last[0])} ${bottom}L${f(pts[0][0])} ${bottom}Z`
}
// Height of the straight-line version of the same ridge at x; close enough to seat trees and houses on the ground.
function heightAt(pts: Pt[], x: number): number {
  for (let i = 0; i < pts.length - 1; i++) {
    if (x >= pts[i][0] && x <= pts[i + 1][0]) return pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * (x - pts[i][0])) / (pts[i + 1][0] - pts[i][0])
  }
  return pts[pts.length - 1][1]
}
// A straight-edged line through the points, closed down to the bottom (for mountains).
const peaks = (pts: Pt[], bottom: number) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}L${f(pts[pts.length - 1][0])} ${bottom}L${f(pts[0][0])} ${bottom}Z`

// A conifer: stacked triangles, the widest tier at the bottom, and a short trunk. All of one path.
function pine(x: number, base: number, h: number): string {
  const tiers = h > 150 ? 5 : h > 70 ? 4 : 3
  const w = h * 0.4
  const top = base - h
  let d = ""
  for (let k = 0; k < tiers; k++) {
    const yt = top + h * 0.52 * (k / tiers)
    const yb = top + h * (0.42 + 0.5 * ((k + 1) / tiers))
    const hw = w * (0.42 + 0.58 * ((k + 1) / tiers))
    d += `M${f(x)} ${f(yt)}L${f(x + hw)} ${f(yb)}L${f(x - hw)} ${f(yb)}Z`
  }
  const tw = Math.max(1.2, w * 0.1)
  d += `M${f(x - tw)} ${f(base - h * 0.1)}h${f(tw * 2)}V${f(base + 2)}h${f(-tw * 2)}Z`
  return d
}
// A row of conifers spaced evenly along a ridge. The heights repeat in a fixed pattern, so the row is regular, not random.
function row(pts: Pt[], x0: number, x1: number, step: number, heights: number[], drop = 0): string {
  let d = ""
  let i = 0
  for (let x = x0; x <= x1; x += step, i++) d += pine(x, heightAt(pts, x) + 4 + drop, heights[i % heights.length])
  return d
}

// The sun or moon: a glow and a disc, both from the palette. The disc can sit on a horizon (it is cut there).
function sunDisc(id: string, cx: number, cy: number, r: number, horizon?: number): string {
  const clip = horizon != null ? `<clipPath id='${id}c'><rect x='0' y='0' width='${W}' height='${horizon}'/></clipPath>` : ""
  return (
    `<defs>${radial(`${id}g`, cx, cy, r * 5.2, [stop(0, "v-sun"), stop(0.38, "v-sun-mid"), stop(1, "v-sun-mid", 0)])}${clip}</defs>` +
    `<circle cx='${cx}' cy='${cy}' r='${f(r * 5.2)}' style='fill:url(#${id}g)'${horizon != null ? ` clip-path='url(#${id}c)'` : ""}/>` +
    `<circle cx='${cx}' cy='${cy}' r='${r}' ${fl("p-ray")}${horizon != null ? ` clip-path='url(#${id}c)'` : ""}/>`
  )
}

// ---- Forest ---------------------------------------------------------------------------------------------------------
export function forest(): Record<"sun" | "far" | "mid" | "near", string> {
  const far: Pt[] = [[-100, 332], [200, 306], [520, 326], [820, 302], [1120, 322], [1420, 304], [1700, 330]]
  const mid: Pt[] = [[-100, 424], [240, 400], [600, 418], [900, 396], [1250, 416], [1700, 402]]
  const near: Pt[] = [[-100, 528], [300, 506], [700, 522], [1000, 504], [1300, 518], [1700, 506]]

  // the cabin sits on the middle ridge, on the left third of the picture
  const cx = 330
  const cy = heightAt(mid, cx) + 6
  const cabin =
    `<path d='M${cx - 30} ${f(cy)}V${f(cy - 34)}H${cx + 30}V${f(cy)}Z' ${fl("p-mid-hi")}/>` +
    `<path d='M${cx - 38} ${f(cy - 33)}L${cx} ${f(cy - 62)}L${cx + 38} ${f(cy - 33)}Z' ${fl("p-tree-n")}/>` +
    `<rect x='${cx + 17}' y='${f(cy - 66)}' width='7' height='16' ${fl("p-tree-n")}/>` +
    `<rect x='${cx - 8}' y='${f(cy - 26)}' width='16' height='16' rx='2' ${fl("v-sun")}/>` +
    `<circle cx='${cx}' cy='${f(cy - 18)}' r='26' ${fl("v-sun-mid", 0.5)}/>`

  return {
    sun: layer(sunDisc("fs", 1190, 214, 40), "pk-still"),
    far: layer(
      `<defs>${lin("ffh", 290, 520, [stop(0, "p-far-hi"), stop(1, "v-haze")])}</defs><path d='${ground(far)}' style='fill:url(#ffh)'/>` +
        `<path d='${row(far, -60, 1660, 22, [30, 38, 34, 44, 34, 40])}' ${fl("p-mid-hi", 0.9)}/>`,
      "pk-hills pk-far",
    ),
    mid: layer(
      `<defs>${lin("fmh", 380, 560, [stop(0, "p-mid-hi"), stop(1, "p-mid")])}</defs><path d='${ground(mid)}' style='fill:url(#fmh)'/>` +
        `<path d='${row(mid, -40, 1640, 40, [96, 112, 104, 124, 100, 118, 108], 0)}' ${fl("p-tree")}/>` +
        cabin,
      "pk-hills pk-mid",
    ),
    near:
      layer(
        `<path d='${ground(near)}' ${fl("p-tree-n")}/>` +
          `<path d='${near.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y + 1}`).join("")}' ${stroke("p-line", 1.4, 0.35)}/>` +
          `<path d='${row(near, -40, 250, 78, [236, 270, 250, 292, 256], 6)}' ${fl("p-tree-n")}/>` +
          `<path d='${row(near, 1330, 1640, 78, [262, 240, 286, 248, 272], 6)}' ${fl("p-tree-n")}/>`,
        "pk-hills pk-near",
      ) + layer(`<g ${stroke("p-line", 2, 0.4)}><path d='M0 590H${W}'/></g>`, "pk-still"),
  }
}

// ---- Sea ------------------------------------------------------------------------------------------------------------
// One horizon at y = 316. The sun sits on it in the middle; its path runs down the water straight below. The lighthouse
// stands on the left third and the boat on the right third.
export function sea(): Record<"sun" | "water" | "waves" | "land", string> {
  const HZ = 316
  const sunX = 1180
  const path = [0, 1, 2, 3, 4, 5, 6]
    .map((i) => {
      const y = HZ + 14 + i * 26
      const w = 46 + i * 34
      const h = 3 + i * 0.9
      return `<rect x='${f(sunX - w / 2)}' y='${f(y)}' width='${w}' height='${f(h)}' rx='${f(h / 2)}' ${fl("p-ray", 0.55 - i * 0.04)}/>`
    })
    .join("")
  const island = `M${260} ${HZ + 1}C280 ${HZ - 22} 330 ${HZ - 30} 366 ${HZ - 12}C382 ${HZ - 4} 394 ${HZ - 2} 410 ${HZ + 1}Z`
  const lx = 330
  const tower = `M${lx - 7} ${HZ - 16}L${lx - 4} ${HZ - 78}H${lx + 4}L${lx + 7} ${HZ - 16}Z`
  const lamp = `M${lx - 7} ${HZ - 78}H${lx + 7}V${HZ - 90}H${lx - 7}Z`
  const cap = `M${lx - 9} ${HZ - 90}L${lx} ${HZ - 102}L${lx + 9} ${HZ - 90}Z`
  const boatX = 1350
  const hull = `M${boatX - 34} ${HZ + 12}H${boatX + 34}L${boatX + 24} ${HZ + 22}H${boatX - 24}Z`
  const sailA = `M${boatX - 2} ${HZ + 8}V${HZ - 62}L${boatX - 30} ${HZ + 8}Z`
  const sailB = `M${boatX + 4} ${HZ + 8}V${HZ - 44}L${boatX + 28} ${HZ + 8}Z`
  const flip = (inner: string, opacity: number) => `<g transform='translate(0 ${HZ * 2}) scale(1 -1)' opacity='${opacity}'>${inner}</g>`
  const objects = `<path d='${island}' ${fl("p-tree-n")}/><path d='${tower}' ${fl("p-ray")}/><path d='${lamp}' ${fl("v-sun")}/><path d='${cap}' ${fl("p-tree-n")}/><path d='${hull}' ${fl("p-tree-n")}/><path d='${sailA}' ${fl("p-ray")}/><path d='${sailB}' ${fl("v-cloud")}/>`
  const wave = (y: number, amp: number) => `M-80 ${y}q100 ${-amp} 200 0` + "t200 0".repeat(9)
  const band = (y: number, amp: number, o: number, w: number) => `<path d='${wave(y, amp)}' ${stroke("p-line", w, o)}/>`
  return {
    sun: layer(sunDisc("ss", sunX, HZ, 38, HZ), "pk-still"),
    water: layer(
      `<defs>${lin("swb", HZ, H, [stop(0, "p-far-hi"), stop(0.5, "p-mid"), stop(1, "p-near")])}</defs>` +
        `<rect x='-40' y='${HZ}' width='${W + 80}' height='${H - HZ + 40}' style='fill:url(#swb)'/>` +
        `<rect x='-40' y='${HZ - 1}' width='${W + 80}' height='2' ${fl("p-line", 0.7)}/>` +
        path +
        flip(objects, 0.28) +
        objects,
      "pk-hills pk-far",
    ),
    waves: layer(
      `<g class='pk-wv-a'>${band(HZ + 34, 4, 0.28, 1.6)}</g><g class='pk-wv-b'>${band(HZ + 70, 6, 0.3, 1.8)}</g><g class='pk-wv-c'>${band(HZ + 118, 8, 0.34, 2)}</g><g class='pk-wv-a'>${band(HZ + 172, 10, 0.4, 2.2)}</g><g class='pk-wv-b'>${band(HZ + 238, 12, 0.46, 2.4)}</g>`,
      "pk-still pk-waveset",
    ),
    land: layer(
      // two dark rocks in the lower corners, a mirror pair
      `<path d='M-80 ${H + 40}V${H - 70}C-10 ${H - 108} 90 ${H - 98} 170 ${H - 60}C230 ${H - 36} 280 ${H - 14} 330 ${H + 40}Z' ${fl("p-tree-n")}/>` +
        `<path d='M${W + 80} ${H + 40}V${H - 70}C${W + 10} ${H - 108} ${W - 90} ${H - 98} ${W - 170} ${H - 60}C${W - 230} ${H - 36} ${W - 280} ${H - 14} ${W - 330} ${H + 40}Z' ${fl("p-tree-n")}/>` +
        `<path d='M60 ${H - 86}C100 ${H - 94} 130 ${H - 84} 160 ${H - 66}' ${stroke("p-line", 1.6, 0.35)}/><path d='M${W - 60} ${H - 86}C${W - 100} ${H - 94} ${W - 130} ${H - 84} ${W - 160} ${H - 66}' ${stroke("p-line", 1.6, 0.35)}/>`,
      "pk-hills pk-near",
    ),
  }
}

// ---- Lake -----------------------------------------------------------------------------------------------------------
// Mountains stand on the waterline at y = 330 and are mirrored in the lake below it. The moon is on the centre line, over the
// main peak; its reflection is the same disc, mirrored. Pines stand on both shores, a mirror pair.
export function lake(): Record<"sun" | "mountains" | "water" | "shore", string> {
  const HZ = 330
  const far: Pt[] = [[-100, 292], [100, 246], [250, 276], [410, 206], [560, 268], [690, 262], [800, 250], [910, 262], [1040, 268], [1190, 206], [1350, 276], [1500, 246], [1700, 292]]
  const mid: Pt[] = [[-100, 322], [150, 286], [320, 312], [510, 254], [670, 318], [800, 304], [930, 318], [1090, 254], [1280, 312], [1450, 286], [1700, 322]]
  const near: Pt[] = [[-100, 340], [200, 316], [520, 334], [800, 322], [1080, 334], [1400, 316], [1700, 340]]
  const mountains = (id: string) =>
    `<defs>${lin(`${id}a`, 206, HZ, [stop(0, "p-far-hi"), stop(1, "v-haze")])}${lin(`${id}b`, 246, HZ, [stop(0, "p-mid-hi"), stop(1, "p-mid")])}</defs>` +
    `<path d='${peaks(far, HZ)}' style='fill:url(#${id}a)'/>` +
    `<path d='${[[410, 206], [1190, 206]].map(([x, y]) => `M${x - 36} ${y + 30}L${x} ${y}L${x + 36} ${y + 30}L${x + 17} ${y + 24}L${x} ${y + 34}L${x - 17} ${y + 24}Z`).join('')}' ${fl('v-cloud', 0.8)}/>` +
    `<path d='${peaks(mid, HZ)}' style='fill:url(#${id}b)'/>` +
    `<path d='${ground(near, HZ)}' ${fl("p-near")}/>` +
    `<path d='${row(near, 60, 1540, 34, [34, 42, 38, 48, 38, 44], 0)}' ${fl("p-tree")}/>`
  const ripples = [370, 392, 420, 456, 500, 552]
    .map((y, i) => {
      const w = 160 + i * 150
      return `<path d='M${f(800 - w)} ${y}H${f(800 + w)}' ${stroke("p-line", 1.6 + i * 0.2, 0.2 + i * 0.05)} stroke-dasharray='${18 + i * 6} ${14 + i * 5}'/>`
    })
    .join("")
  const shoreL = (m: number) => {
    const edge = m === 1 ? 0 : W
    const s = m
    return (
      `<path d='M${edge - s * 80} ${H + 40}V${H - 96}C${edge + s * 40} ${H - 112} ${edge + s * 190} ${H - 86} ${edge + s * 330} ${H + 40}Z' ${fl("p-tree-n")}/>` +
      `<path d='${[0, 1, 2, 3, 4]
        .map((i) => pine(edge + s * (22 + i * 62), H - 96 + (i % 2 ? 22 : 8) + i * 9, [220, 270, 236, 286, 250][i]))
        .join("")}' ${fl("p-tree-n")}/>`
    )
  }
  return {
    sun: layer(sunDisc("ls", 1190, 104, 34), "pk-still"),
    mountains: layer(mountains("lm"), "pk-hills pk-far"),
    water: layer(
      `<defs>${lin("lwb", HZ, H, [stop(0, "p-mid-hi"), stop(0.55, "p-mid"), stop(1, "p-near")])}` +
        `<filter id='lrip' x='-5%' y='-5%' width='110%' height='110%'><feTurbulence type='fractalNoise' baseFrequency='0.0035 0.09' numOctaves='2' seed='7' result='n'/><feDisplacementMap in='SourceGraphic' in2='n' scale='10' xChannelSelector='R' yChannelSelector='G'/></filter></defs>` +
        `<rect x='-40' y='${HZ}' width='${W + 80}' height='${H - HZ + 40}' style='fill:url(#lwb)'/>` +
        `<g opacity='0.5' filter='url(#lrip)'><g transform='translate(0 ${HZ * 2}) scale(1 -1)'>${mountains("lr")}<circle cx='1190' cy='104' r='34' ${fl("p-ray")}/></g></g>` +
        `<rect x='-40' y='${HZ - 1}' width='${W + 80}' height='2' ${fl("p-line", 0.7)}/>` +
        ripples,
      "pk-hills pk-mid",
    ),
    shore: layer(shoreL(1) + shoreL(-1), "pk-hills pk-near"),
  }
}
