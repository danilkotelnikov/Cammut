// The AS cube of the Arc Science brand. The letters sit on the left face.
// "colour" is the blue cube with white letters. "mono" is one colour (currentColor) with the letters cut out,
// so on a light page it is black with the page showing through the letters, on a dark page it is white.
const TOP = "M128.00 18.80L220.15 72.00L128.00 125.20L35.85 72.00Z"
const LEFT = "M33.43 76.20L125.58 129.40L125.58 235.80L33.43 182.60Z"
const RIGHT = "M130.42 129.40L222.57 76.20L222.57 182.60L130.42 235.80Z"
const LETTERS =
  "M43.61 161.18L54.83 115.85L65.30 121.90L76.51 180.17L67.54 174.99L64.92 161.40L55.20 155.78L52.59 166.36ZM60.06 136.14L63.05 151.68L57.07 148.23ZM82.49 131.83L109.41 147.37L115.39 157.73L115.39 161.18L91.47 147.37L91.47 157.73L115.39 171.54L115.39 202.62L88.47 187.08L82.49 176.72L82.49 173.27L106.42 187.08L106.42 176.72L82.49 162.91Z"

export function AsCube({ size = 40, variant = "mono", title }: { size?: number; variant?: "colour" | "mono"; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {variant === "colour" ? (
        <>
          <path d={TOP} fill="#566A9C" />
          <path d={LEFT} fill="#1D397B" />
          <path d={RIGHT} fill="#182D5F" />
          <path d={LETTERS} fill="#FFFFFF" fillRule="evenodd" />
        </>
      ) : (
        <>
          <path d={TOP} fill="currentColor" />
          <path d={LEFT + LETTERS} fill="currentColor" fillRule="evenodd" />
          <path d={RIGHT} fill="currentColor" />
        </>
      )}
    </svg>
  )
}

export function Wordmark({ size = 40, colour = false }: { size?: number; colour?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5" style={{ color: "var(--logo-ink)" }}>
      <AsCube size={size} variant={colour ? "colour" : "mono"} />
      <span className="font-semibold tracking-tight" style={{ fontSize: size * 0.55 }}>
        Cammut
      </span>
    </span>
  )
}
