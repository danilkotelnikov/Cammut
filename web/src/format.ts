const scopeRe = /^[A-Za-z0-9._*/-]{1,80}$/

/** Splits free text into unique scopes; commas, spaces and newlines all separate. */
export function parseScopes(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[\s,]+/)) {
    const s = part.trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** Returns a message for the first scope the server would refuse, or null. */
export function scopeProblem(scopes: string[]): string | null {
  for (const s of scopes) {
    if (s.length > 80) return `Scope "${s.slice(0, 20)}…" is longer than 80 characters.`
    if (!scopeRe.test(s)) return `Scope "${s}" has characters other than letters, digits and . _ * / -`
  }
  return null
}

export function tokenState(t: { revoked: boolean; expires_at: string | null }, now = new Date()): "active" | "revoked" | "expired" {
  if (t.revoked) return "revoked"
  if (t.expires_at && new Date(t.expires_at).getTime() <= now.getTime()) return "expired"
  return "active"
}

export function relativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return "never"
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const diff = Math.round((now.getTime() - t) / 1000)
  const abs = Math.abs(diff)
  const unit = abs < 60 ? null : abs < 3600 ? [60, "min"] : abs < 86400 ? [3600, "h"] : [86400, "d"]
  if (!unit) return diff >= 0 ? "just now" : "in a moment"
  const n = Math.round(abs / (unit[0] as number))
  return diff >= 0 ? `${n} ${unit[1]} ago` : `in ${n} ${unit[1]}`
}

export function formatTime(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** GITHUB_TOKEN for "github"; always a valid secret name. */
export function secretNameFor(upstream: string): string {
  let base = upstream.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  if (/^[0-9]/.test(base)) base = "_" + base
  return `${base || "UPSTREAM"}_TOKEN`
}
