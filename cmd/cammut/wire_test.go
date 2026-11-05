package main

import (
	"bytes"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cammut/internal/auth"
	"cammut/internal/oauth"
	"cammut/internal/service"
	"cammut/internal/store"
	"cammut/internal/upstream"
	"cammut/internal/vault"
)

func TestBuildAdminFailsClosedOnABadKey(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	mgr := upstream.NewManager(func(string) string { return "" })
	if _, err := buildAdmin(st, mgr, filepath.Join(dir, "missing.key")); err == nil {
		t.Fatal("a missing key must disable the console")
	}
	good := filepath.Join(dir, "vault.key")
	if err := vault.InitKey(good); err != nil {
		t.Fatal(err)
	}
	p, err := buildAdmin(st, mgr, good)
	if err != nil || p == nil || p.auth == nil || p.svc == nil {
		t.Fatalf("a good key must build the console: %+v %v", p, err)
	}
}

func TestPrivateHandlerRoutesAndOrigins(t *testing.T) {
	dir := t.TempDir()
	st, _ := store.Open(filepath.Join(dir, "w.db"))
	defer st.Close()
	key := filepath.Join(dir, "vault.key")
	vault.InitKey(key)
	p, err := buildAdmin(st, upstream.NewManager(func(string) string { return "" }), key)
	if err != nil {
		t.Fatal(err)
	}
	h := privateHandler(p, "127.0.0.1:7422", slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	if h == nil {
		t.Fatal("no handler")
	}
	// cammut.localhost gives the console its own cookie jar: cookies are not isolated by port, so on 127.0.0.1
	// every other local web app the browser visits would otherwise receive the session cookie.
	want := []string{"http://127.0.0.1:7422", "http://localhost:7422", "http://cammut.localhost:7422"}
	if got := privateOrigins("127.0.0.1:7422"); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("private origins: %v", got)
	}
}

func TestBuildAdminErrorsTellTheOperatorHowToCreateTheKey(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	mgr := upstream.NewManager(func(string) string { return "" })
	// when a bind-mounted key file does not exist, Docker creates a directory in its place
	dockerMade := filepath.Join(dir, "made-by-docker")
	if err := os.Mkdir(dockerMade, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{"missing": filepath.Join(dir, "missing.key"), "directory": dockerMade} {
		_, err := buildAdmin(st, mgr, path)
		if err == nil || !strings.Contains(err.Error(), "admin vault-init") || !strings.Contains(err.Error(), "65532") {
			t.Fatalf("%s: the error must say how to create the key and who must own it, got: %v", name, err)
		}
	}
}

func TestAdminListenMustBeLoopback(t *testing.T) {
	for _, ok := range []string{"127.0.0.1:7422", "localhost:7422", "[::1]:7422", "127.0.0.2:9"} {
		if err := checkAdminListen(ok); err != nil {
			t.Fatalf("%s must be allowed: %v", ok, err)
		}
	}
	for _, bad := range []string{"0.0.0.0:7422", ":7422", "[::]:7422", "10.0.0.5:7422", "203.0.113.9:7422", "example.org:7422", "7422", ""} {
		if err := checkAdminListen(bad); err == nil {
			t.Fatalf("%q must be refused: the private console carries a password and a code in clear text", bad)
		}
	}
}

func TestPrivateListenerIgnoresForwardedFor(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	key := filepath.Join(dir, "vault.key")
	if err := vault.InitKey(key); err != nil {
		t.Fatal(err)
	}
	p, err := buildAdmin(st, upstream.NewManager(func(string) string { return "" }), key)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(nil)
	addr := srv.Listener.Addr().String()
	srv.Config.Handler = privateHandler(p, addr, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	srv.Start()
	defer srv.Close()
	login := func(xff string) int {
		t.Helper()
		body := strings.NewReader(`{"username":"nobody","password":"not the password at all","code":"000000"}`)
		r, _ := http.NewRequest("POST", srv.URL+"/api/v1/login", body)
		r.Header.Set("Origin", "http://"+addr)
		r.Header.Set("X-Requested-With", "cammut")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", xff)
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	for i := 1; i <= 5; i++ {
		if c := login(fmt.Sprintf("198.51.100.%d", i)); c != 401 {
			t.Fatalf("attempt %d: %d", i, c)
		}
	}
	// every request comes from the same local peer; a header it sets itself must not buy it a fresh allowance
	if c := login("198.51.100.99"); c != 429 {
		t.Fatalf("a sixth attempt from the same peer must be throttled whatever X-Forwarded-For says, got %d", c)
	}
}

func TestReplicaStaleNeedsSegmentsAndAnOldOrMissingRun(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	for _, c := range []struct {
		segments int
		last     time.Time
		want     bool
	}{
		{0, time.Time{}, false},
		{5, time.Time{}, true},
		{5, now.Add(-35 * time.Hour), false},
		{5, now.Add(-37 * time.Hour), true},
		{0, now.Add(-100 * time.Hour), false},
	} {
		if got := replicaStale(c.segments, c.last, now); got != c.want {
			t.Errorf("%+v: got %v", c, got)
		}
	}
}

// The private (-admin-listen) console must carry the OAuth routes too: before the fix they answered 404 there.
func TestPrivateHandlerServesTheOAuthRoutes(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	v, err := vault.New(bytes.Repeat([]byte{7}, 32), st) // an in-memory key: no key file, so no file-mode checks
	if err != nil {
		t.Fatal(err)
	}
	a, err := auth.New(st, v, auth.NewHasher(2, 1))
	if err != nil {
		t.Fatal(err)
	}
	p := &adminParts{auth: a, svc: service.New(st, upstream.NewManager(func(string) string { return "" }), v, os.Getenv), vault: v, oauth: oauth.New(st)}
	h := privateHandler(p, "127.0.0.1:7422", slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	for _, path := range []string{"/api/v1/oauth/clients", "/api/v1/oauth/requests/x"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != http.StatusUnauthorized { // 401 = the route exists and wants a session; 404 = not mounted
			t.Fatalf("%s: got %d, want 401", path, w.Code)
		}
	}
}
