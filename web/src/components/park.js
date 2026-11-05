// A soft park landscape drawn in SVG: three layers of rolling hills, a treeline along the ridges, a wave-line strip and clouds.
// Own paths from a seeded generator (not traced from any painting or photo). Hills end on a straight horizon; the cube
// field starts there and nothing from the landscape crosses it. Colours are CSS variables (--p-*, --v-*) set per theme.
// Each hill layer is its own <svg> in a 1600 x 400 box (the horizon is its bottom edge) so the page can move it.

const W = 1600, H = 400;
const f = (n) => (Math.round(n * 10) / 10).toString();
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const fl = (n, o) => `style='fill:var(--${n})${o != null ? ';fill-opacity:' + o : ''}'`;
const stop = (off, n, o) => `<stop offset='${off}' style='stop-color:var(--${n})${o != null ? ';stop-opacity:' + o : ''}'/>`;
const grad = (id, y1, y2, stops) => `<linearGradient id='${id}' gradientUnits='userSpaceOnUse' x1='0' y1='${y1}' x2='0' y2='${y2}'>${stops.join('')}</linearGradient>`;
const svg = (inner, vb = `0 0 ${W} ${H}`, par = 'xMidYMax slice') => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${vb}' preserveAspectRatio='${par}' aria-hidden='true' focusable='false' style='overflow:visible'>${inner}</svg>`;

// Catmull-Rom through the points, as cubic Beziers. Closed down to the bottom edge (a little below it, so no seam shows).
function hill(pts) {
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${f(last[0])} ${H + 30}L${f(pts[0][0])} ${H + 30}Z`;
}
const sq = (pts) => pts.map(([x, y]) => [x, Math.round(400 - (400 - y) * 0.78)]);
// Height of the sampled ridge at x (straight lines between the sample points, close enough to seat a treeline).
const ridgeY = (pts, x) => {
  for (let i = 0; i < pts.length - 1; i++) if (x >= pts[i][0] && x <= pts[i + 1][0]) { const t = (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0]); return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t; }
  return pts[pts.length - 1][1];
};

// A treeline: a band of rounded crowns along the ridge from x0 to x1, darker at the crest and fading out downhill.
// Soft and flat on purpose: it reads as forest, not as drawn trees.
function treeline(pts, x0, x1, amp, seed, id) {
  const r = rng(seed);
  let x = x0, up = `M${f(x0)} ${f(ridgeY(pts, x0) + 3)}`;
  while (x < x1) {
    const w = 9 + r() * 15, xe = Math.min(x1, x + w), h = amp * (0.55 + r() * 0.9);
    const y0 = ridgeY(pts, x) + 3, y1 = ridgeY(pts, xe) + 3;
    up += `C${f(x + (xe - x) * 0.1)} ${f(y0 - h * 1.45)} ${f(xe - (xe - x) * 0.1)} ${f(y1 - h * 1.45)} ${f(xe)} ${f(y1)}`;
    x = xe;
  }
  const y = ridgeY(pts, x1) + amp * 2.6, ys = ridgeY(pts, x0) + amp * 2.6;
  return `<path d='${up}L${f(x1)} ${f(y)}L${f(x0)} ${f(ys)}Z' style='fill:url(#${id})'/>`;
}

export function layers() {
  const out = {};

  // clouds: one 1600 wide tile of soft streaks; the page lays two side by side and drifts them
  {
    const streak = (cx, cy, w, h) => `M${f(cx - w)} ${f(cy)}C${f(cx - w * 0.55)} ${f(cy - h)} ${f(cx + w * 0.5)} ${f(cy - h * 1.1)} ${f(cx + w)} ${f(cy)}C${f(cx + w * 0.5)} ${f(cy + h * 0.55)} ${f(cx - w * 0.5)} ${f(cy + h * 0.6)} ${f(cx - w)} ${f(cy)}Z`;
    let a = '', b = '';
    const spec = [[170, 120, 160, 15], [420, 212, 200, 12], [640, 76, 130, 11], [880, 160, 230, 16], [1120, 98, 160, 13], [1350, 224, 190, 12], [1480, 64, 110, 10], [60, 266, 120, 10], [770, 266, 150, 9], [330, 48, 120, 9], [1000, 260, 120, 8], [560, 150, 100, 8]];
    spec.forEach(([cx, cy, w, h], i) => { const p = streak(cx, cy, w, h) + streak(cx + w * 0.22, cy - h * 0.55, w * 0.55, h * 0.7) + streak(cx - w * 0.3, cy + h * 0.9, w * 0.5, h * 0.4); if (i % 2) b += p; else a += p; });
    out.clouds = svg(
      `<defs><filter id='cb' x='-10%' y='-50%' width='120%' height='200%'><feGaussianBlur stdDeviation='5'/></filter></defs>` +
      `<g filter='url(#cb)'><path d='${b}' ${fl('v-cloud2', 0.7)}/><path d='${a}' ${fl('v-cloud', 0.78)}/></g>`,
      '0 0 1600 360', 'xMidYMin slice');
  }

  // far hills: pale, hazed toward the pink of the sky
  {
    const pts = sq([[-120, 250], [80, 222], [300, 196], [520, 226], [760, 208], [980, 168], [1200, 214], [1400, 190], [1720, 236]]);
    out.far = svg(`<defs>${grad('hf', 160, 400, [stop(0, 'p-far-hi'), stop(1, 'v-haze')])}</defs><path d='${hill(pts)}' style='fill:url(#hf)'/>`);
  }

  // mid hills with a treeline on both flanks (the middle stays bare: the title sits there)
  {
    const pts = sq([[-120, 300], [100, 262], [360, 248], [600, 284], [820, 268], [1040, 244], [1280, 278], [1500, 256], [1720, 292]]);
    const tl = `<g class='pk-sw' style='--td:11s;--tl:-3s'>${treeline(pts, -120, 520, 7, 23, 'tm1')}</g><g class='pk-sw' style='--td:13s;--tl:-7s'>${treeline(pts, 1040, 1720, 7, 29, 'tm1')}</g>`;
    out.mid = svg(`<defs>${grad('hm', 230, 400, [stop(0, 'p-mid-hi'), stop(1, 'p-mid')])}${grad('tm1', 220, 290, [stop(0, 'p-tree'), stop(1, 'p-tree', 0)])}</defs><path d='${hill(pts)}' style='fill:url(#hm)'/>${tl}`);
  }

  // near hills: a taller, darker treeline
  {
    const pts = sq([[-120, 352], [160, 318], [420, 310], [700, 342], [960, 326], [1240, 338], [1480, 312], [1720, 338]]);
    const tl = `<g class='pk-sw' style='--td:9s;--tl:-2s'>${treeline(pts, -120, 470, 11, 41, 'tn1')}</g><g class='pk-sw' style='--td:12s;--tl:-5s'>${treeline(pts, 1120, 1720, 11, 47, 'tn1')}</g>`;
    out.near = svg(`<defs>${grad('hn', 300, 400, [stop(0, 'p-near-hi'), stop(1, 'p-near')])}${grad('tn1', 280, 340, [stop(0, 'p-tree-n'), stop(1, 'p-tree-n', 0)])}</defs><path d='${hill(pts)}' style='fill:url(#hn)'/>${tl}`);
  }

  // wave lines on the lowest hill foot: one tile 1600 wide with a period of 400, the page scrolls two tiles side by side
  {
    const wave = (y, a) => `<path d='M0 ${y}q100 ${-a} 200 0` + 't200 0'.repeat(7) + `' fill='none' stroke-linecap='round'/>`;
    out.waves = svg(
      `<g style='stroke:var(--p-line)'><g stroke-width='2.4' stroke-opacity='.55'>${wave(14, 9)}</g><g stroke-width='2' stroke-opacity='.38'>${wave(30, 8)}</g><g stroke-width='1.6' stroke-opacity='.26'>${wave(44, 7)}</g></g>`,
      '0 0 1600 56', 'none');
  }
  return out;
}
export const PARK_SIZE = { W, H };
