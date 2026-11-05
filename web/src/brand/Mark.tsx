// The Cammut mark: an open ring in the current text colour.
export function Mark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M18.4 6.6a8.5 8.5 0 1 0 0 10.8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function Wordmark({ size = 40 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5" style={{ color: "var(--logo-ink)" }}>
      <Mark size={size} />
      <span className="font-semibold tracking-tight" style={{ fontSize: size * 0.55 }}>
        Cammut
      </span>
    </span>
  )
}
