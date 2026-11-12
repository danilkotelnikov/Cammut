// Static site generator for the Cammut site. Markdown (content/docs) + hand-written pages (src/pages) -> dist/.
// No client framework: the output is plain HTML, one stylesheet, and two tiny scripts.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Marked } from "marked"

const root = dirname(fileURLToPath(import.meta.url))
const out = join(root, "dist")
const ORIGIN = process.env.SITE_ORIGIN || "https://example.com"
const cfg = JSON.parse(readFileSync(join(root, "site.json"), "utf8"))
const versions = JSON.parse(readFileSync(join(root, "versions.json"), "utf8"))

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

function frontMatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return [{}, src]
  const meta = {}
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":")
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return [meta, src.slice(m[0].length)]
}

// ---- markdown -> html -------------------------------------------------------------------------------------------
const marked = new Marked({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens)
      const id = slug(text)
      return `<h${depth} id="${id}">${text}${depth > 1 ? ` <a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : ""}</h${depth}>\n`
    },
    code({ text, lang }) {
      const label = esc(lang || "text")
      return `<figure class="code"><figcaption><span>${label}</span><button type="button" class="copy" data-copy>COPY</button></figcaption><pre><code>${esc(text)}</code></pre></figure>\n`
    },
    table(token) {
      const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join("")
      const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("")
      return `<div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      const ext = /^https?:\/\//.test(href) && !href.startsWith(ORIGIN)
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}${ext ? ' rel="noopener noreferrer"' : ""}>${text}</a>`
    },
  },
})

// ---- page shell -------------------------------------------------------------------------------------------------
const NAV = [
  ["/docs/", "Docs"],
  ["/setup/", "Setup guide"],
  ["/download/", "Download"],
]
const themeBoot = `try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`

function shell({ title, desc, path, body, scripts = [], active = "" }) {
  const full = path === "/" ? "Cammut — one MCP endpoint for every agent" : `${title} — Cammut`
  const nav = NAV.map(([href, label]) => `<a href="${href}"${active === href ? ' aria-current="page"' : ""}>${label}</a>`).join("")
  const js = ["/assets/app.js", ...scripts].map((s) => `<script src="${s}" defer></script>`).join("")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${ORIGIN}${path}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23000'/%3E%3Cpath d='M22 9H12v14h10v-3h-7v-8h7z' fill='%23fff'/%3E%3C/svg%3E">
<script>${themeBoot}</script>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap bar">
<a class="brand" href="/">CAMMUT<span>/${esc(cfg.tagline_short)}</span></a>
<nav aria-label="Main">${nav}<button type="button" id="theme" class="navbtn" aria-label="Toggle dark mode">INVERT</button></nav>
</div></header>
<main id="main">
${body}
</main>
<footer class="foot"><div class="wrap">
<p><strong>CAMMUT ${esc(versions.latest)}</strong> — self-hosted MCP gateway and agent memory. Built for one operator and their agents.</p>
<p><a href="/docs/">Docs</a> · <a href="/setup/">Setup guide</a> · <a href="/download/">Download</a> · <a href="/docs/security/">Security</a> · <a href="/docs/limits/">Limits</a></p>
<p class="dim">No cookies, no trackers, no external requests. Every page is static HTML.</p>
</div></footer>
${js}
</body>
</html>
`
}

function write(path, html) {
  const dir = join(out, path)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "index.html"), html)
}

// ---- build ------------------------------------------------------------------------------------------------------
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, "assets"), { recursive: true })
for (const f of readdirSync(join(root, "src"))) {
  if (/\.(css|js)$/.test(f)) copyFileSync(join(root, "src", f), join(out, "assets", f))
}

// docs
const docsDir = join(root, "content", "docs")
const docs = readdirSync(docsDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => {
    const [meta, md] = frontMatter(readFileSync(join(docsDir, f), "utf8"))
    const name = f.replace(/\.md$/, "")
    return { name, meta, md, path: name === "index" ? "/docs/" : `/docs/${name}/` }
  })
  .sort((a, b) => Number(a.meta.order ?? 99) - Number(b.meta.order ?? 99))

const sidebar = (cur) =>
  `<nav class="side" aria-label="Documentation"><details open><summary>Documentation</summary><ol>${docs
    .map((d) => `<li><a href="${d.path}"${d.path === cur ? ' aria-current="page"' : ""}>${esc(d.meta.title || d.name)}</a></li>`)
    .join("")}</ol></details></nav>`

docs.forEach((d, i) => {
  const html = marked.parse(d.md)
  const heads = [...html.matchAll(/<h2 id="([^"]+)">(.*?) <a class="anchor"/g)]
  const toc = heads.length > 2 ? `<nav class="toc" aria-label="On this page"><strong>ON THIS PAGE</strong><ul>${heads.map((h) => `<li><a href="#${h[1]}">${h[2]}</a></li>`).join("")}</ul></nav>` : ""
  const prev = docs[i - 1], next = docs[i + 1]
  const pager = `<div class="pager">${prev ? `<a href="${prev.path}">← ${esc(prev.meta.title)}</a>` : "<span></span>"}${next ? `<a href="${next.path}">${esc(next.meta.title)} →</a>` : ""}</div>`
  const body = `<div class="wrap docs">${sidebar(d.path)}<article>${d.meta.kicker ? `<p class="kicker">${esc(d.meta.kicker)}</p>` : ""}${toc}${html}${pager}</article></div>`
  write(d.path, shell({ title: d.meta.title || d.name, desc: d.meta.description || cfg.description, path: d.path, body, active: "/docs/" }))
})

// hand-written pages: src/pages/<name>.html with {{versions}} style placeholders
const fill = (s) =>
  s
    .replaceAll("{{latest}}", esc(versions.latest))
    .replaceAll("{{endpoint_placeholder}}", esc(cfg.endpoint_placeholder))
    .replaceAll("{{measured}}", esc(cfg.measured))
    .replaceAll("{{changelog}}", changelogHtml())
    .replaceAll("{{downloads}}", downloadsHtml())

function changelogHtml() {
  return versions.versions
    .map((v) => `<article class="rel"><h3>${esc(v.version)} <small>${esc(v.date)}</small></h3><ul>${v.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></article>`)
    .join("")
}

function downloadsHtml() {
  const files = (versions.downloads || []).filter((d) => existsSync(join(root, "public", d.file)))
  if (!files.length) {
    return `<div class="box"><h3>No public build yet</h3><p>The first public artifacts (source archive, Linux binary and container image) will be listed here with their SHA-256. Until then the project is not downloadable: that is deliberate, because the working tree still contains operator-specific scripts that must be scrubbed first.</p></div>`
  }
  return `<div class="tbl"><table><thead><tr><th>File</th><th>Version</th><th>Size</th><th>SHA-256</th></tr></thead><tbody>${files
    .map((d) => `<tr><td><a href="/${esc(d.file)}">${esc(d.file.split("/").pop())}</a></td><td>${esc(d.version)}</td><td>${esc(d.size)}</td><td><code>${esc(d.sha256)}</code></td></tr>`)
    .join("")}</tbody></table></div>`
}

const pages = [
  { src: "home.html", path: "/", title: "Cammut", desc: cfg.description, scripts: [], active: "" },
  { src: "setup.html", path: "/setup/", title: "Setup guide", desc: "Interactive guide: generate the exact token command, environment variable and config snippet for Claude Code, Codex CLI or Warp. Runs in your browser; nothing is sent anywhere.", scripts: ["/assets/setup.js"], active: "/setup/" },
  { src: "download.html", path: "/download/", title: "Download", desc: "Versions, changelog and checksums for Cammut, the self-hosted MCP gateway.", scripts: [], active: "/download/" },
]
for (const p of pages) {
  write(p.path, shell({ title: p.title, desc: p.desc, path: p.path, body: fill(readFileSync(join(root, "src", "pages", p.src), "utf8")), scripts: p.scripts, active: p.active }))
}

// 404, robots, sitemap, versions.json (public copy)
writeFileSync(join(out, "404.html"), shell({ title: "Not found", desc: "Page not found.", path: "/404.html", body: `<div class="wrap prose"><h1>404</h1><p>Nothing here. <a href="/">Home</a> · <a href="/docs/">Docs</a></p></div>` }))
const urls = ["/", "/setup/", "/download/", ...docs.map((d) => d.path)]
writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${ORIGIN}${u}</loc></url>`).join("\n")}\n</urlset>\n`)
writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`)
writeFileSync(join(out, "versions.json"), JSON.stringify({ latest: versions.latest, versions: versions.versions.map(({ version, date }) => ({ version, date })) }, null, 2) + "\n")
if (existsSync(join(root, "public"))) {
  const walk = (dir, rel = "") => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(dir, r)
      else {
        mkdirSync(dirname(join(out, r)), { recursive: true })
        copyFileSync(join(dir, r), join(out, r))
      }
    }
  }
  walk(join(root, "public"))
}
console.log(`built ${docs.length} doc pages + ${pages.length} pages + 404 into dist/`)
