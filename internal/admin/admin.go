// Package admin is the console's JSON API: session cookies, CSRF checks, and thin handlers over internal/service.
package admin

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"cammut/internal/auth"
	"cammut/internal/clientip"
	"cammut/internal/memory"
	"cammut/internal/oauth"
	"cammut/internal/service"
	"cammut/internal/store"
	"cammut/internal/vault"
)

const (
	cookieName = "__Host-cammut"
	maxBody    = 64 << 10
)

// Config wires one listener's admin API. Private marks the SSH-only listener (reserved hashing slot).
type Config struct {
	Auth         *auth.Auth
	Svc          *service.Service
	Throttle     *auth.Throttle
	Origins      []string
	SiteOrigin   string // the public origin (-site-origin), shown to the signed-in user so the setup page can build the MCP URL; empty if unset
	Private      bool
	LoginEnabled bool
	// GitHubOnly, with LoginEnabled, keeps GitHub sign-in but turns the password form off: the public listener, where real client
	// addresses do not reach us, so a password could be guessed against one shared failure counter. The private listener never sets it.
	GitHubOnly    bool
	GitHub        func() *auth.GitHub           // nil, or returning nil, means GitHub login is not configured
	Memory        *memory.Service               // nil leaves the /api/v1/memory routes unmounted
	OAuth         *oauth.Service                // nil leaves the /api/v1/oauth routes unmounted
	ArchiveAlerts func() (ArchiveAlerts, error) // nil leaves /api/v1/archive/alerts unmounted
	Log           *slog.Logger
}

type handler struct {
	c   Config
}

func New(c Config) http.Handler {
	if c.Log == nil {
		c.Log = slog.Default()
	}
	h := &handler{c: c}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/login", h.guard(h.login))
	mux.HandleFunc("POST /api/v1/logout", h.guard(h.logout))
	mux.HandleFunc("GET /api/v1/me", h.authed(h.me))
	mux.HandleFunc("GET /api/v1/auth/methods", h.methods)

	mux.HandleFunc("GET /api/v1/upstreams", h.authed(h.upstreamList))
	mux.HandleFunc("POST /api/v1/upstreams", h.guard(h.authed(h.upstreamAdd)))
	mux.HandleFunc("PATCH /api/v1/upstreams/{name}", h.guard(h.authed(h.upstreamPatch)))
	mux.HandleFunc("DELETE /api/v1/upstreams/{name}", h.guard(h.authed(h.upstreamDelete)))
	mux.HandleFunc("POST /api/v1/upstreams/{name}/test", h.guard(h.authed(h.upstreamTest)))

	mux.HandleFunc("GET /api/v1/tokens", h.authed(h.tokenList))
	mux.HandleFunc("POST /api/v1/tokens", h.guard(h.authed(h.tokenCreate)))
	mux.HandleFunc("PATCH /api/v1/tokens/{label}", h.guard(h.authed(h.tokenPatch)))
	mux.HandleFunc("DELETE /api/v1/tokens/{label}", h.guard(h.authed(h.tokenRevoke)))

	mux.HandleFunc("GET /api/v1/secrets", h.authed(h.secretList))
	mux.HandleFunc("PUT /api/v1/secrets/{name}", h.guard(h.authed(h.secretPut)))
	mux.HandleFunc("PUT /api/v1/secrets/{name}/policy", h.guard(h.authed(h.secretPolicy)))
	mux.HandleFunc("DELETE /api/v1/secrets/{name}", h.guard(h.authed(h.secretDelete)))

	mux.HandleFunc("GET /api/v1/audit", h.authed(h.auditList))
	if c.Memory != nil {
		h.registerMemory(mux)
	}
	if c.OAuth != nil {
		h.registerOAuth(mux)
	}
	if c.ArchiveAlerts != nil {
		mux.HandleFunc("GET /api/v1/archive/alerts", h.authed(h.archiveAlerts))
	}
	h.registerGitHub(mux)
	return mux
}

// ---- plumbing ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func jsonErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (h *handler) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		jsonErr(w, 404, err.Error())
	case errors.Is(err, service.ErrExists):
		jsonErr(w, 409, err.Error())
	case errors.Is(err, service.ErrBadInput), errors.Is(err, memory.ErrBadInput):
		jsonErr(w, 400, err.Error())
	case errors.Is(err, memory.ErrNotFound):
		jsonErr(w, 404, err.Error())
	default:
		h.c.Log.Error("admin api", "err", err)
		jsonErr(w, 500, "internal error")
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			jsonErr(w, 413, "request too large")
		} else {
			jsonErr(w, 400, "invalid JSON body")
		}
		return false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		jsonErr(w, 400, "invalid JSON body")
		return false
	}
	return true
}

func (h *handler) originOK(o string) bool {
	return o != "" && o != "null" && slices.Contains(h.c.Origins, o)
}

// guard enforces the CSRF rules on everything that is not a plain read.
func (h *handler) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if r.Header.Get("X-Requested-With") != "cammut" {
				jsonErr(w, 403, "missing X-Requested-With header")
				return
			}
			if !h.originOK(r.Header.Get("Origin")) {
				jsonErr(w, 403, "origin not allowed")
				return
			}
			if r.ContentLength != 0 && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				jsonErr(w, 415, "content type must be application/json")
				return
			}
		}
		next(w, r)
	}
}

// privateCookieName is used on the SSH-only listener, which is plain http on loopback: the __Host- prefix needs
// Secure, and some browsers drop a Secure cookie set over http, which would loop the login silently.
const privateCookieName = "cammut"

func (h *handler) cookieName() string {
	if h.c.Private {
		return privateCookieName
	}
	return cookieName
}

func (h *handler) setSession(w http.ResponseWriter, token string, life time.Duration) {
	http.SetCookie(w, &http.Cookie{Name: h.cookieName(), Value: token, Path: "/", Secure: !h.c.Private, HttpOnly: true,
		SameSite: http.SameSiteStrictMode, MaxAge: int(life.Seconds())})
}

func (h *handler) clearSession(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: h.cookieName(), Value: "", Path: "/", Secure: !h.c.Private, HttpOnly: true,
		SameSite: http.SameSiteStrictMode, MaxAge: -1})
}

type userHandler func(w http.ResponseWriter, r *http.Request, u store.User)

func (h *handler) authed(next userHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(h.cookieName())
		if err != nil {
			jsonErr(w, 401, "login required")
			return
		}
		u, ok := h.c.Auth.Session(c.Value)
		if !ok {
			h.clearSession(w)
			jsonErr(w, 401, "login required")
			return
		}
		next(w, r, u)
	}
}

func actor(r *http.Request, u store.User) service.Actor {
	return service.Actor{Kind: "user", Name: u.Username, IP: clientip.FromRequest(r)}
}

// ---- session ----

func (h *handler) login(w http.ResponseWriter, r *http.Request) {
	if !h.c.LoginEnabled || h.c.GitHubOnly {
		http.NotFound(w, r)
		return
	}
	var in struct{ Username, Password, Code string }
	if !readJSON(w, r, &in) {
		return
	}
	ip := clientip.FromRequest(r)
	tok, err := h.c.Auth.Login(h.c.Throttle, h.c.Private, ip, r.UserAgent(), in.Username, in.Password, in.Code)
	var blocked *auth.BlockedError
	switch {
	case errors.As(err, &blocked):
		// refused before any work: not audited, so a flood of blocked requests is not a flood of rows
		w.Header().Set("Retry-After", strconv.Itoa(int(blocked.RetryAfter.Seconds())+1))
		jsonErr(w, 429, "too many attempts")
	case errors.Is(err, auth.ErrBusy):
		w.Header().Set("Retry-After", "2")
		jsonErr(w, 503, "busy, try again in a moment")
	case errors.Is(err, auth.ErrInvalid):
		h.c.Svc.AuditAuth(ip, "", "auth.fail", false, "password")
		jsonErr(w, 401, "invalid credentials")
	case err != nil:
		h.c.Log.Error("login", "err", err)
		jsonErr(w, 500, "internal error")
	default:
		h.auditSignIn(ip, tok, "password")
		h.setSession(w, tok, h.c.Auth.Abs)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

// auditSignIn names the person behind a fresh session token in the audit log.
func (h *handler) auditSignIn(ip, token, via string) {
	if u, ok := h.c.Auth.Session(token); ok {
		h.c.Svc.AuditAuth(ip, "user:"+u.Username, "auth.login", true, via)
	}
}

func (h *handler) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(h.cookieName()); err == nil {
		if u, ok := h.c.Auth.Session(c.Value); ok {
			h.c.Svc.AuditAuth(clientip.FromRequest(r), "user:"+u.Username, "auth.logout", true, "")
		}
		h.c.Auth.Logout(c.Value)
	}
	h.clearSession(w)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (h *handler) me(w http.ResponseWriter, r *http.Request, u store.User) {
	writeJSON(w, 200, map[string]any{"username": u.Username, "github_linked": u.GitHubID != 0, "site_origin": h.c.SiteOrigin})
}

func (h *handler) methods(w http.ResponseWriter, r *http.Request) {
	gh := h.c.LoginEnabled && h.c.GitHub != nil && h.c.GitHub() != nil
	writeJSON(w, 200, map[string]bool{"password": h.c.LoginEnabled && !h.c.GitHubOnly, "github": gh})
}

// ---- upstreams ----

func (h *handler) upstreamList(w http.ResponseWriter, r *http.Request, u store.User) {
	views, err := h.c.Svc.Upstreams(r.Context())
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, 200, views)
}

func (h *handler) upstreamAdd(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		Name         string `json:"name"`
		URL          string `json:"url"`
		BearerEnv    string `json:"bearer_env"`
		BearerSecret string `json:"bearer_secret"`
		AuthHeader   string `json:"auth_header"`
		Enabled      *bool  `json:"enabled"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	enabled := in.Enabled == nil || *in.Enabled
	err := h.c.Svc.UpstreamAdd(actor(r, u), store.Upstream{Name: in.Name, URL: in.URL, BearerEnv: in.BearerEnv, BearerSecret: in.BearerSecret, AuthHeader: in.AuthHeader, Enabled: enabled})
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, 201, map[string]string{"name": in.Name})
}

func (h *handler) upstreamPatch(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		URL          *string `json:"url"`
		BearerEnv    *string `json:"bearer_env"`
		BearerSecret *string `json:"bearer_secret"`
		AuthHeader   *string `json:"auth_header"`
		Enabled      *bool   `json:"enabled"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	err := h.c.Svc.UpstreamUpdate(actor(r, u), r.PathValue("name"), service.UpstreamPatch{URL: in.URL, BearerEnv: in.BearerEnv, BearerSecret: in.BearerSecret, AuthHeader: in.AuthHeader, Enabled: in.Enabled})
	if err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handler) upstreamDelete(w http.ResponseWriter, r *http.Request, u store.User) {
	if err := h.c.Svc.UpstreamRemove(actor(r, u), r.PathValue("name")); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handler) upstreamTest(w http.ResponseWriter, r *http.Request, u store.User) {
	res, err := h.c.Svc.UpstreamTest(r.Context(), actor(r, u), r.PathValue("name"))
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, 200, res)
}

// ---- tokens ----

type tokenView struct {
	ID         int64    `json:"id"`
	Label      string   `json:"label"`
	Scopes     []string `json:"scopes"`
	Revoked    bool     `json:"revoked"`
	CreatedAt  *string  `json:"created_at"`
	LastUsedAt *string  `json:"last_used_at"`
	ExpiresAt  *string  `json:"expires_at"`
	Profile    string   `json:"profile"`
}

func ts(t time.Time) *string {
	if t.IsZero() {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}

func viewOf(t store.Token) tokenView {
	if t.Scopes == nil {
		t.Scopes = []string{}
	}
	return tokenView{ID: t.ID, Label: t.Label, Scopes: t.Scopes, Revoked: t.Revoked, CreatedAt: ts(t.CreatedAt), LastUsedAt: ts(t.LastUsedAt), ExpiresAt: ts(t.ExpiresAt), Profile: t.Profile}
}

func (h *handler) tokenList(w http.ResponseWriter, r *http.Request, u store.User) {
	toks, err := h.c.Svc.Tokens()
	if err != nil {
		h.fail(w, err)
		return
	}
	out := make([]tokenView, 0, len(toks))
	for _, t := range toks {
		out = append(out, viewOf(t))
	}
	writeJSON(w, 200, out)
}

func (h *handler) tokenCreate(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		Label          string   `json:"label"`
		Scopes         []string `json:"scopes"`
		ExpiresInHours int      `json:"expires_in_hours"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	plain, tok, err := h.c.Svc.TokenCreate(actor(r, u), service.TokenCreate{Label: in.Label, Scopes: in.Scopes, Expires: time.Duration(in.ExpiresInHours) * time.Hour})
	if err != nil {
		h.fail(w, err)
		return
	}
	v := viewOf(tok)
	writeJSON(w, 201, map[string]any{"label": v.Label, "scopes": v.Scopes, "expires_at": v.ExpiresAt, "token": plain})
}

func (h *handler) tokenPatch(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		Scopes []string `json:"scopes"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if err := h.c.Svc.TokenSetScopes(actor(r, u), r.PathValue("label"), in.Scopes); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handler) tokenRevoke(w http.ResponseWriter, r *http.Request, u store.User) {
	if err := h.c.Svc.TokenRevoke(actor(r, u), r.PathValue("label")); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(204)
}

// ---- secrets ----

func (h *handler) secretList(w http.ResponseWriter, r *http.Request, u store.User) {
	meta, err := h.c.Svc.Secrets()
	if err != nil {
		h.fail(w, err)
		return
	}
	out := make([]map[string]any, 0, len(meta))
	for _, m := range meta {
		hosts := m.Hosts
		if hosts == nil {
			hosts = []string{}
		}
		out = append(out, map[string]any{"name": m.Name, "updated_at": ts(m.UpdatedAt), "purpose": m.Purpose, "hosts": hosts})
	}
	writeJSON(w, 200, out)
}

func (h *handler) secretPut(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		Value   string   `json:"value"`
		Purpose string   `json:"purpose"`
		Hosts   []string `json:"hosts"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	var pol *vault.Policy
	if in.Purpose != "" || len(in.Hosts) > 0 {
		pol = &vault.Policy{Purpose: in.Purpose, Hosts: in.Hosts}
	}
	if err := h.c.Svc.SecretPut(actor(r, u), r.PathValue("name"), in.Value, pol); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(204)
}

// secretPolicy is the only route that changes a secret's purpose or hosts; the body must repeat the secret's name.
func (h *handler) secretPolicy(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		Purpose string   `json:"purpose"`
		Hosts   []string `json:"hosts"`
		Confirm string   `json:"confirm"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if err := h.c.Svc.SecretSetPolicy(actor(r, u), r.PathValue("name"), vault.Policy{Purpose: in.Purpose, Hosts: in.Hosts}, in.Confirm); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handler) secretDelete(w http.ResponseWriter, r *http.Request, u store.User) {
	if err := h.c.Svc.SecretDelete(actor(r, u), r.PathValue("name")); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(204)
}

// ---- audit ----

func (h *handler) auditList(w http.ResponseWriter, r *http.Request, u store.User) {
	q := r.URL.Query()
	f := store.AuditFilter{Upstream: q.Get("upstream"), Tool: q.Get("tool")}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			jsonErr(w, 400, "bad limit")
			return
		}
		f.Limit = n
	}
	if v := q.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			jsonErr(w, 400, "bad offset")
			return
		}
		f.Offset = n
	}
	switch q.Get("ok") {
	case "":
	case "true", "false":
		b := q.Get("ok") == "true"
		f.OK = &b
	default:
		jsonErr(w, 400, "bad ok value")
		return
	}
	for key, dst := range map[string]*time.Time{"since": &f.Since, "until": &f.Until} {
		if v := q.Get(key); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				jsonErr(w, 400, "bad "+key+" time (use RFC 3339)")
				return
			}
			*dst = t
		}
	}
	if label := q.Get("token"); label != "" {
		tok, ok, err := h.c.Svc.Token(label)
		if err != nil {
			h.fail(w, err)
			return
		}
		if !ok {
			writeJSON(w, 200, []any{})
			return
		}
		f.TokenID = tok.ID
	}
	rows, err := h.c.Svc.AuditQuery(f)
	if err != nil {
		h.fail(w, err)
		return
	}
	out := make([]map[string]any, 0, len(rows))
	for _, a := range rows {
		out = append(out, map[string]any{
			"ts": ts(a.TS), "token_id": a.TokenID, "upstream": a.Upstream, "tool": a.Tool, "ok": a.OK,
			"ms": a.Millis, "note": a.Note, "ip": a.IP, "actor": a.Actor,
		})
	}
	writeJSON(w, 200, out)
}
