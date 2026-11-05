package admin

import (
	"errors"
	"net/http"
	"time"

	"cammut/internal/auth"
	"cammut/internal/clientip"
	"cammut/internal/ratelimit"
)

const (
	oauthCookie   = "__Host-cammut-oauth"   // SameSite=Lax: it must survive the redirect back from GitHub
	pendingCookie = "__Host-cammut-pending" // SameSite=Strict: only the console's own requests carry it
)

func (h *handler) github() *auth.GitHub {
	if !h.c.LoginEnabled || h.c.GitHub == nil {
		return nil
	}
	return h.c.GitHub()
}

func setCookie(w http.ResponseWriter, name, value string, maxAge int, same http.SameSite) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", Secure: true, HttpOnly: true, SameSite: same, MaxAge: maxAge})
}

func (h *handler) registerGitHub(mux *http.ServeMux) {
	starts := ratelimit.New(0.5, 10) // starting a login writes a row, so it is rate limited as a whole

	mux.HandleFunc("GET /auth/github/start", func(w http.ResponseWriter, r *http.Request) {
		gh := h.github()
		if gh == nil {
			http.NotFound(w, r)
			return
		}
		if !starts.Allow(1, time.Now()) {
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}
		u, state, err := h.c.Auth.GitHubStart(gh)
		if err != nil {
			h.c.Log.Error("github start", "err", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		setCookie(w, oauthCookie, state, 600, http.SameSiteLaxMode)
		http.Redirect(w, r, u, http.StatusFound)
	})

	mux.HandleFunc("GET /auth/github/callback", func(w http.ResponseWriter, r *http.Request) {
		gh := h.github()
		if gh == nil {
			http.NotFound(w, r)
			return
		}
		cookieState := ""
		if c, err := r.Cookie(oauthCookie); err == nil {
			cookieState = c.Value
		}
		setCookie(w, oauthCookie, "", -1, http.SameSiteLaxMode)
		fail := func() { http.Redirect(w, r, "/console/login?error=github", http.StatusFound) }
		q := r.URL.Query()
		if q.Get("error") != "" {
			fail()
			return
		}
		if gh.Direct {
			ip := clientip.FromRequest(r)
			tok, err := h.c.Auth.GitHubSignIn(r.Context(), gh, ip, r.UserAgent(), q.Get("state"), cookieState, q.Get("code"))
			if err != nil {
				h.c.Svc.AuditAuth(ip, "", "auth.fail", false, "github")
				fail()
				return
			}
			h.auditSignIn(ip, tok, "github")
			h.setSession(w, tok, h.c.Auth.Abs)
			http.Redirect(w, r, "/console/login?github=done", http.StatusFound)
			return
		}
		pending, err := h.c.Auth.GitHubFinish(r.Context(), gh, q.Get("state"), cookieState, q.Get("code"))
		if err != nil {
			fail()
			return
		}
		setCookie(w, pendingCookie, pending, 300, http.SameSiteStrictMode)
		http.Redirect(w, r, "/console/login?github=1", http.StatusFound)
	})

	mux.HandleFunc("POST /api/v1/login/github", h.guard(h.githubComplete))
}

func (h *handler) githubComplete(w http.ResponseWriter, r *http.Request) {
	if h.github() == nil {
		http.NotFound(w, r)
		return
	}
	var in struct{ Code string }
	if !readJSON(w, r, &in) {
		return
	}
	c, err := r.Cookie(pendingCookie)
	if err != nil {
		jsonErr(w, 401, "invalid credentials")
		return
	}
	ip := clientip.FromRequest(r)
	tok, err := h.c.Auth.GitHubComplete(h.c.Throttle, ip, r.UserAgent(), c.Value, in.Code)
	var blocked *auth.BlockedError
	switch {
	case errors.As(err, &blocked):
		w.Header().Set("Retry-After", "60")
		jsonErr(w, 429, "too many attempts")
	case errors.Is(err, auth.ErrInvalid):
		h.c.Svc.AuditAuth(ip, "", "auth.fail", false, "github")
		jsonErr(w, 401, "invalid credentials")
	case err != nil:
		h.c.Log.Error("github complete", "err", err)
		jsonErr(w, 500, "internal error")
	default:
		h.auditSignIn(ip, tok, "github")
		setCookie(w, pendingCookie, "", -1, http.SameSiteStrictMode)
		h.setSession(w, tok, h.c.Auth.Abs)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}
