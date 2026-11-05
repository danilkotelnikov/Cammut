package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func get(h http.Handler, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}

func built() fstest.MapFS {
	return fstest.MapFS{
		"index.html":            {Data: []byte("<!doctype html><title>Cammut</title>")},
		"assets/app-abc123.js":  {Data: []byte("console.log(1)")},
		"assets/app-abc123.css": {Data: []byte("body{}")},
		"favicon.svg":           {Data: []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")},
	}
}

func TestIndexAndClientRoutesGetTheShell(t *testing.T) {
	h := handler(built())
	for _, p := range []string{"/console/", "/console/servers", "/console/tokens/new", "/console/login"} {
		w := get(h, "GET", p)
		body, _ := io.ReadAll(w.Body)
		if w.Code != 200 || !strings.Contains(string(body), "<title>Cammut</title>") {
			t.Fatalf("%s: %d %q", p, w.Code, body)
		}
		if w.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("%s: the shell must not be cached, got %q", p, w.Header().Get("Cache-Control"))
		}
	}
}

func TestAssetsAreImmutableAndTyped(t *testing.T) {
	h := handler(built())
	w := get(h, "GET", "/console/assets/app-abc123.js")
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Type"), "javascript") || !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("js: %d %v", w.Code, w.Header())
	}
	if w := get(h, "GET", "/console/assets/app-abc123.css"); !strings.Contains(w.Header().Get("Content-Type"), "css") {
		t.Fatalf("css type: %v", w.Header())
	}
	if w := get(h, "GET", "/console/favicon.svg"); w.Code != 200 || !strings.Contains(w.Header().Get("Content-Type"), "svg") {
		t.Fatalf("svg: %d %v", w.Code, w.Header())
	}
}

func TestMissingAssetsAre404NotTheShell(t *testing.T) {
	h := handler(built())
	for _, p := range []string{"/console/assets/nope.js", "/console/missing.png", "/console/assets/"} {
		if w := get(h, "GET", p); w.Code != 404 {
			t.Fatalf("%s: got %d, want 404", p, w.Code)
		}
	}
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	h := handler(built())
	for _, p := range []string{"/console/", "/console/assets/app-abc123.js", "/console/assets/nope.js"} {
		w := get(h, "GET", p)
		csp := w.Header().Get("Content-Security-Policy")
		for _, want := range []string{"default-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"} {
			if !strings.Contains(csp, want) {
				t.Fatalf("%s: CSP %q lacks %q", p, csp, want)
			}
		}
		if strings.Contains(csp, "script-src") && strings.Contains(csp, "unsafe-eval") {
			t.Fatalf("%s: scripts must not allow eval", p)
		}
		if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("X-Frame-Options") != "DENY" || w.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatalf("%s: headers %v", p, w.Header())
		}
	}
}

func TestOnlyReadsAreAllowedAndAnUnbuiltUIIsExplicit(t *testing.T) {
	if w := get(handler(built()), "POST", "/console/"); w.Code != 405 {
		t.Fatalf("POST: %d", w.Code)
	}
	if w := get(handler(built()), "HEAD", "/console/"); w.Code != 200 {
		t.Fatalf("HEAD: %d", w.Code)
	}
	empty := handler(fstest.MapFS{".gitkeep": {}})
	w := get(empty, "GET", "/console/")
	if w.Code != 503 || !strings.Contains(w.Body.String(), "not built") {
		t.Fatalf("an unbuilt UI must say so: %d %q", w.Code, w.Body.String())
	}
}
