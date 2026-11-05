package oauth

import (
	"encoding/json"
	"errors"
	"hash/fnv"
	"net/http"
	"strings"
	"time"

	"cammut/internal/clientip"
	"cammut/internal/ratelimit"
)

// Handler serves the discovery documents, /oauth/authorize and /oauth/token. issuer is the public origin, such as
// https://app.example, with no trailing slash. /oauth/authorize needs no cookie: it only records the request and
// sends the browser to the console, where the owner (signed in) answers it.
func (s *Service) Handler(issuer string) http.Handler {
	issuer = strings.TrimRight(issuer, "/")
	// Behind the front door every caller looks like 127.0.0.1, so token callers are told apart by the client id they name:
	// 256 buckets, so a flood naming made-up ids cannot use up the allowance of the real app (unless it names the real id).
	limit := ratelimit.New(5, 30)
	authLimit := ratelimit.New(2, 20)
	mux := http.NewServeMux()

	resource := func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{
			"resource":                 issuer + "/mcp",
			"authorization_servers":    []string{issuer},
			"bearer_methods_supported": []string{"header"},
		})
	}
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", resource)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", resource)
	mux.HandleFunc("GET /.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{
			"issuer":                                issuer,
			"authorization_endpoint":                issuer + "/oauth/authorize",
			"token_endpoint":                        issuer + "/oauth/token",
			"response_types_supported":              []string{"code"},
			"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
			"code_challenge_methods_supported":      []string{"S256"},
			"token_endpoint_auth_methods_supported": []string{"client_secret_post", "client_secret_basic"},
		})
	})

	mux.HandleFunc("GET /oauth/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if !authLimit.Allow(1, time.Now()) {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}
		redirect := q.Get("redirect_uri")
		fail := func(code string) {
			http.Redirect(w, r, Redirect(redirect, map[string]string{"error": code, "state": q.Get("state")}), http.StatusFound)
		}
		p := AuthParams{ClientID: q.Get("client_id"), RedirectURI: redirect, State: q.Get("state"), Challenge: q.Get("code_challenge")}
		// Until the client and the redirect address are known to match, nothing is redirected: an unregistered address is an attacker's.
		c, ok, err := s.ClientFor(p.ClientID)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		registered := false
		for _, u := range c.RedirectURIs {
			registered = registered || (ok && u == redirect)
		}
		if !registered {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(http.StatusBadRequest)
			// the same words whether or not the app exists; the address is echoed only when it is one plain https address
			msg := "This app is not set up in Cammut for that address."
			if validRedirect(redirect) {
				msg += " If it is your app, open the Cammut console, go to Apps, and add this exact address:\n\n" + redirect
			}
			_, _ = w.Write([]byte(msg + "\n"))
			return
		}
		if q.Get("response_type") != "code" {
			fail("unsupported_response_type")
			return
		}
		if len(p.State) > 512 {
			fail("invalid_request")
			return
		}
		if p.Challenge != "" && (q.Get("code_challenge_method") != "S256" || !challengeRe.MatchString(p.Challenge)) {
			fail("invalid_request")
			return
		}
		id, err := s.Begin(p)
		switch {
		case errors.Is(err, ErrBusy):
			fail("temporarily_unavailable")
		case err != nil:
			http.Error(w, "internal error", http.StatusInternalServerError)
		default:
			http.Redirect(w, r, "/console/oauth?req="+id, http.StatusFound)
		}
	})

	mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		if err := r.ParseForm(); err != nil {
			tokenErr(w, 400, "invalid_request")
			return
		}
		id, secret, hasBasic := r.BasicAuth()
		if !hasBasic {
			id, secret = r.PostForm.Get("client_id"), r.PostForm.Get("client_secret")
		}
		if !limit.Allow(bucket(id), time.Now()) {
			w.Header().Set("Retry-After", "1")
			tokenErr(w, 429, "slow_down")
			return
		}
		who := Who{IP: clientip.FromRequest(r)} // the service names the client in the audit only after it proved who it is
		var t Tokens
		var err error
		switch r.PostForm.Get("grant_type") {
		case "authorization_code":
			t, err = s.Exchange(who, id, secret, r.PostForm.Get("code"), r.PostForm.Get("redirect_uri"), r.PostForm.Get("code_verifier"))
		case "refresh_token":
			t, err = s.Refresh(who, id, secret, r.PostForm.Get("refresh_token"))
		default:
			tokenErr(w, 400, "unsupported_grant_type")
			return
		}
		switch {
		case errors.Is(err, ErrInvalidClient):
			w.Header().Set("WWW-Authenticate", `Basic realm="cammut"`)
			tokenErr(w, 401, "invalid_client")
		case errors.Is(err, ErrInvalidGrant):
			tokenErr(w, 400, "invalid_grant")
		case err != nil:
			tokenErr(w, 500, "server_error")
		default:
			writeJSON(w, 200, map[string]any{
				"access_token":  t.Access,
				"token_type":    "Bearer",
				"expires_in":    int(t.Expires.Seconds()),
				"refresh_token": t.Refresh,
				"scope":         strings.Join(t.Scopes, " "),
			})
		}
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func bucket(id string) int64 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	return int64(h.Sum32() % 256)
}

func tokenErr(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}
