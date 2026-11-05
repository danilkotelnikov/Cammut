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

func TestOAuthIsMountedOnlyWhenProvidedAndTheChallengePointsToIt(t *testing.T) {
	st, _ := store.Open(t.TempDir() + "/o.db")
	defer st.Close()
	mgr := upstream.NewManager(func(string) string { return "" })
	oa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "oauth "+r.URL.Path) })
	with := httptest.NewServer(Handler(Deps{Store: st, Mgr: mgr, Limiter: ratelimit.New(10, 10), OAuth: oa, PublicURL: "https://app.test/"}))
	defer with.Close()
	without := httptest.NewServer(Handler(Deps{Store: st, Mgr: mgr, Limiter: ratelimit.New(10, 10)}))
	defer without.Close()

	for _, path := range []string{"/oauth/token", "/.well-known/oauth-authorization-server"} {
		resp, _ := http.Get(with.URL + path)
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || string(b) != "oauth "+path {
			t.Errorf("%s: %d %q", path, resp.StatusCode, b)
		}
		if resp, _ := http.Get(without.URL + path); resp.StatusCode != 404 {
			t.Errorf("%s without OAuth must be 404, got %d", path, resp.StatusCode)
		}
	}

	post := func(base string) *http.Response {
		resp, err := http.Post(base+"/mcp", "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}
	got := post(with.URL).Header.Get("WWW-Authenticate")
	if !strings.Contains(got, `Bearer realm="cammut"`) || !strings.Contains(got, `resource_metadata="https://app.test/.well-known/oauth-protected-resource"`) {
		t.Fatalf("challenge: %q", got)
	}
	if got := post(without.URL).Header.Get("WWW-Authenticate"); got != `Bearer realm="cammut"` {
		t.Fatalf("without a public URL the challenge stays as before: %q", got)
	}
}
