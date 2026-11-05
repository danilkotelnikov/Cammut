package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"cammut/internal/ratelimit"
	"cammut/internal/store"
	"cammut/internal/upstream"
)

func TestAdminAndConsoleAreMountedOnlyWhenProvided(t *testing.T) {
	st, _ := store.Open(t.TempDir() + "/m.db")
	defer st.Close()
	mgr := upstream.NewManager(func(string) string { return "" })
	say := func(s string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, s+" "+r.URL.Path) })
	}
	with := httptest.NewServer(Handler(Deps{Store: st, Mgr: mgr, Limiter: ratelimit.New(10, 10), Admin: say("admin"), Console: say("console")}))
	defer with.Close()
	without := httptest.NewServer(Handler(Deps{Store: st, Mgr: mgr, Limiter: ratelimit.New(10, 10)}))
	defer without.Close()

	body := func(base, path string) (int, string) {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	for path, want := range map[string]string{
		"/api/v1/me": "admin /api/v1/me", "/auth/github/start": "admin /auth/github/start", "/console/servers": "console /console/servers",
	} {
		if code, b := body(with.URL, path); code != 200 || b != want {
			t.Fatalf("%s: %d %q", path, code, b)
		}
		if code, _ := body(without.URL, path); code != 404 {
			t.Fatalf("%s without the console must be 404, got %d", path, code)
		}
	}
	if code, b := body(with.URL, "/"); code != 200 || !strings.Contains(b, "Cammut") {
		t.Fatalf("the landing page must stay public: %d", code)
	}
	if code, _ := body(with.URL, "/healthz"); code != 200 {
		t.Fatal("healthz must stay")
	}
}
