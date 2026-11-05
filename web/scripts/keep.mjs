// vite empties the output directory, which would delete the tracked placeholder the Go embed needs
import { writeFileSync } from "node:fs"
writeFileSync(new URL("../../internal/web/dist/.gitkeep", import.meta.url), "")
