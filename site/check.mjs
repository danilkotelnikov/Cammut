// Post-build checks: links and anchors resolve, no external requests, size budgets hold.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const dist = join(fileURLToPath(new URL(".", import.meta.url)), "dist")
const BUDGET = { html: 60_000, css: 15_000, js: 10_000 }
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
const files = walk(dist)
const rel = (f) => f.slice(dist.length).replace(/\\/g, "/")
const pageOf = (url) => {
  const p = url.split("#")[0].split("?")[0]
  const f = join(dist, p)
  if (existsSync(f) && statSync(f).isFile()) return f
  const idx = join(dist, p, "index.html")
  return existsSync(idx) ? idx : null
}
let bad = 0
const fail = (m) => { console.log("FAIL", m); bad++ }

const ids = new Map()
for (const f of files.filter((x) => x.endsWith(".html"))) ids.set(f, new Set([...readFileSync(f, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])))

for (const f of files) {
  const ext = f.split(".").pop()
  const size = statSync(f).size
  if (BUDGET[ext] && size > BUDGET[ext]) fail(`${rel(f)} is ${size} bytes, budget ${BUDGET[ext]}`)
  if (ext !== "html") continue
  const html = readFileSync(f, "utf8")
  for (const m of html.matchAll(/<(?:link|script|img|source)\b[^>]*?\s(?:src|href)="(https?:)?\/\/[^"]+"/g)) if (!/rel="canonical"/.test(m[0])) fail(`${rel(f)} requests an external resource: ${m[0].slice(0, 90)}`)
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const u = m[1]
    if (/^(https?:|mailto:|data:|javascript:)/.test(u)) continue
    const target = u.startsWith("#") ? f : pageOf(u.startsWith("/") ? u : "/" + u)
    if (!target) { fail(`${rel(f)} links to missing ${u}`); continue }
    const hash = u.includes("#") ? u.split("#")[1] : ""
    if (hash && target.endsWith(".html") && !ids.get(target)?.has(hash)) fail(`${rel(f)} links to missing anchor ${u}`)
  }
}
const total = files.reduce((n, f) => n + statSync(f).size, 0)
console.log(`${files.length} files, ${(total / 1024).toFixed(1)} KiB total, ${bad ? bad + " problems" : "all checks passed"}`)
process.exit(bad ? 1 : 0)
