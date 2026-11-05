// Local preview of dist/ on 127.0.0.1:4173 (not for production).
import { createServer } from "node:http"
import { readFileSync, existsSync, statSync } from "node:fs"
import { join, extname, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const dist = join(fileURLToPath(new URL(".", import.meta.url)), "dist")
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain" }
createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "")
  let f = join(dist, p)
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html")
  if (!existsSync(f)) { res.writeHead(404, { "content-type": types[".html"] }); return res.end(readFileSync(join(dist, "404.html"))) }
  res.writeHead(200, { "content-type": types[extname(f)] || "application/octet-stream" })
  res.end(readFileSync(f))
}).listen(4173, "127.0.0.1", () => console.log("http://127.0.0.1:4173"))
