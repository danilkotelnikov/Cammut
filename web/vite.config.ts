import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// During `npm run dev` the API is proxied to the private listener (open the SSH tunnel first); the Origin is
// rewritten because the server only accepts its own origin on state-changing calls.
const private_ = "http://127.0.0.1:7422"
const proxy = { target: private_, headers: { Origin: private_ } }

export default defineConfig({
  base: "/console/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../internal/web/dist", emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { "/api": proxy, "/auth": proxy } },
  // HeroUI + React Aria in jsdom is slow on the first render and per keystroke; typing a login form takes seconds.
  test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"], globals: true, css: false, testTimeout: 30000 },
})
