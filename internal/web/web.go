// Package web serves the built console (web/ is built into internal/web/dist) from inside the binary.
package web

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed all:dist
var embedded embed.FS

// Handler serves the embedded console for URLs under /console/.
func Handler() http.Handler {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err)
	}
	return handler(sub)
}

const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
	"frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

func handler(fsys fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := path.Clean("/" + strings.TrimPrefix(r.URL.Path, "/console/"))[1:]
		if p == "" {
			p = "index.html"
		}
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			// a client-side route such as /console/servers gets the shell; a missing file or asset does not
			// (a missing index.html is the "UI not built" case below, not a 404)
			if p != "index.html" && (path.Ext(p) != "" || p == "assets" || strings.HasPrefix(p, "assets/")) {
				http.NotFound(w, r)
				return
			}
			p = "index.html"
			if data, err = fs.ReadFile(fsys, p); err != nil {
				http.Error(w, "the console UI is not built into this binary", http.StatusServiceUnavailable)
				return
			}
		}
		if p == "index.html" {
			h.Set("Cache-Control", "no-cache")
		} else if strings.HasPrefix(p, "assets/") {
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		http.ServeContent(w, r, p, time.Time{}, bytes.NewReader(data))
	})
}
