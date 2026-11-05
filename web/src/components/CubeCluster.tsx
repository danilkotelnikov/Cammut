// Seven cubes in a ring: one lit cube in the middle and six around it. The colours come from the page palette
// (--cl-c, --cl-1..--cl-3), so the mark changes with the picture.
const S = 20 // cube edge in the drawing
const W = S * Math.sqrt(3)
const RING = ["var(--cl-1)", "var(--cl-2)", "var(--cl-3)", "var(--cl-1)", "var(--cl-2)", "var(--cl-3)"]

// centre first, then the six neighbours of a pointy hex tiling
const SPOTS: { x: number; y: number; fill: string }[] = [
  { x: 0, y: 0, fill: "var(--cl-c)" },
  { x: W, y: 0, fill: RING[0] },
  { x: W / 2, y: 1.5 * S, fill: RING[1] },
  { x: -W / 2, y: 1.5 * S, fill: RING[2] },
  { x: -W, y: 0, fill: RING[3] },
  { x: -W / 2, y: -1.5 * S, fill: RING[4] },
  { x: W / 2, y: -1.5 * S, fill: RING[5] },
]

export function CubeCluster({ size = 112, title }: { size?: number; title?: string }) {
  const spanX = 3 * W
  const spanY = 5 * S
  const pad = 2
  // drawn back to front so the lower cubes overlap the upper ones
  const order = [...SPOTS].sort((a, b) => a.y - b.y)
  return (
    <svg
      width={size}
      height={(size * (spanY + 2 * pad)) / (spanX + 2 * pad)}
      viewBox={`${-spanX / 2 - pad} ${-spanY / 2 - pad} ${spanX + 2 * pad} ${spanY + 2 * pad}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      data-testid="cube-cluster"
    >
      {order.map((c, i) => {
        const x = c.x - W / 2
        const y = c.y - S
        const top = `${x + W / 2},${y} ${x + W},${y + S / 2} ${x + W / 2},${y + S} ${x},${y + S / 2}`
        const left = `${x},${y + S / 2} ${x + W / 2},${y + S} ${x + W / 2},${y + 2 * S} ${x},${y + 1.5 * S}`
        const right = `${x + W / 2},${y + S} ${x + W},${y + S / 2} ${x + W},${y + 1.5 * S} ${x + W / 2},${y + 2 * S}`
        return (
          <g key={i} data-testid="cube">
            <polygon points={left} fill={c.fill} stroke={c.fill} strokeWidth="0.6" strokeLinejoin="round" />
            <polygon points={right} fill={c.fill} stroke={c.fill} strokeWidth="0.6" strokeLinejoin="round" />
            <polygon points={right} fill="var(--cl-right)" />
            <polygon points={top} fill={c.fill} stroke={c.fill} strokeWidth="0.6" strokeLinejoin="round" />
            <polygon points={top} fill="var(--cl-top)" />
            <g fill="none" stroke="var(--cl-edge)" strokeWidth="0.9" strokeLinejoin="round">
              <polygon points={top} />
              <polygon points={left} />
              <polygon points={right} />
            </g>
          </g>
        )
      })}
    </svg>
  )
}
