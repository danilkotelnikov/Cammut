package main

import (
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"cammut/internal/admin"
	"cammut/internal/archive"
	"cammut/internal/auth"
	"cammut/internal/memory"
	"cammut/internal/oauth"
	"cammut/internal/service"
	"cammut/internal/store"
	"cammut/internal/upstream"
	"cammut/internal/vault"
	"cammut/internal/web"
)

// adminParts is everything the console needs; it exists only when the vault key loads.
type adminParts struct {
	auth       *auth.Auth
	svc        *service.Service
	vault      *vault.Vault
	mem        *memory.Service                     // set by serve once the memory service exists
	alert      func() (admin.ArchiveAlerts, error) // set by serve once the archive store exists; nil leaves the route off
	siteOrigin string                              // -site-origin, passed to both console listeners
	oauth      *oauth.Service                      // one service for both console listeners (and the public OAuth endpoints)
}

// backfillPolicies runs the one-time secret-policy backfill. Without it every existing secret stays at purpose
// "other" and every MCP bearer fails closed.
func backfillPolicies(p *adminParts, log *slog.Logger) {
	res, err := p.svc.BackfillSecretPolicies()
	if err != nil {
		log.Error("secret policy backfill failed: stored secrets keep purpose \"other\" and are not sent anywhere until you set a policy with `cammut admin secret policy`", "err", err.Error())
	} else if res.Ran {
		log.Info("secret policy backfill done: each secret may be sent only for its purpose to its hosts; tighten with `cammut admin secret policy`", "assigned", res.Assigned, "quarantined", res.Quarantined)
	}
}

func buildAdmin(st *store.Store, mgr *upstream.Manager, keyPath string) (*adminParts, error) {
	key, err := vault.LoadKey(keyPath)
	if err != nil {
		return nil, fmt.Errorf("%w; create the key once with `cammut admin vault-init -key %s` (in Docker run it inside the image: the container user is uid 65532 and the file must be owned by it, mode 0400)", err, keyPath)
	}
	v, err := vault.New(key, st)
	if err != nil {
		return nil, err
	}
	// two public hashing slots plus one that only the private listener may use
	a, err := auth.New(st, v, auth.NewHasher(2, 1))
	if err != nil {
		return nil, err
	}
	return &adminParts{auth: a, svc: service.New(st, mgr, v, os.Getenv), vault: v, oauth: oauth.New(st)}, nil
}

func (p *adminParts) lookup(name string) string {
	if v, ok, err := p.vault.Get(name); err == nil && ok {
		return v
	}
	return os.Getenv(name)
}

// githubConfig reads the OAuth App settings on every call, so storing them makes GitHub login appear
// without a restart. It returns nil while either value is missing.
func githubConfig(p *adminParts, siteOrigin string) func() *auth.GitHub {
	return func() *auth.GitHub {
		id, secret := p.lookup("GITHUB_OAUTH_CLIENT_ID"), p.lookup("GITHUB_OAUTH_CLIENT_SECRET")
		if id == "" || secret == "" {
			return nil
		}
		return &auth.GitHub{
			ClientID: id, ClientSecret: secret, RedirectURL: siteOrigin + "/auth/github/callback",
			Direct: p.lookup("GITHUB_SIGNIN") == "direct", AllowedIDs: parseIDs(p.lookup("GITHUB_ALLOWED_IDS")),
		}
	}
}

// parseIDs reads a comma-separated list of GitHub numeric ids; anything that is not a number is ignored.
func parseIDs(s string) []int64 {
	var out []int64
	for _, f := range strings.Split(s, ",") {
		if n, err := strconv.ParseInt(strings.TrimSpace(f), 10, 64); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	return out
}

// checkAdminListen refuses anything but a loopback address: the private console carries the password and the
// authenticator code in clear text, so its only safe path is an SSH tunnel.
func checkAdminListen(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("-admin-listen %q: want host:port on loopback, for example 127.0.0.1:7422", addr)
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("-admin-listen %q is not a loopback address: the private console sends the password and the authenticator code in clear text and must be reached through an SSH tunnel only", addr)
	}
	return nil
}

// privateOrigins lists the origins the private console accepts. cammut.localhost resolves to loopback in current
// browsers and gives the console its own cookie jar (cookies are not isolated by port).
func privateOrigins(addr string) []string {
	_, port, _ := net.SplitHostPort(addr)
	return []string{"http://127.0.0.1:" + port, "http://localhost:" + port, "http://cammut.localhost:" + port}
}

// privateHandler serves the console on the SSH-only listener: password login with its own throttle and the
// reserved hashing slot, no GitHub login (its callback lives on the public name).
func privateHandler(p *adminParts, addr string, log *slog.Logger) http.Handler {
	api := admin.New(admin.Config{
		Auth: p.auth, Svc: p.svc, Throttle: auth.NewThrottle(nil), Origins: privateOrigins(addr), SiteOrigin: p.siteOrigin,
		Private: true, LoginEnabled: true, Memory: p.mem, OAuth: p.oauth, ArchiveAlerts: p.alert, Log: log,
	})
	// Every peer of this listener is loopback, so a forwarded-for header here is set by the client itself:
	// believing it would hand any local process a fresh login allowance per request and forge the audit address.
	ownPeerOnly := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Del("X-Forwarded-For")
		api.ServeHTTP(w, r)
	})
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", ownPeerOnly)
	mux.Handle("/console/", web.Handler())
	mux.HandleFunc("/{$}", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/console/", http.StatusFound) })
	return mux
}

func newServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr: addr, Handler: h,
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second,
		WriteTimeout: 120 * time.Second, IdleTimeout: 120 * time.Second,
	}
}

// replicaStaleAfter matches the sweeper's replicaMaxAgeHours default: older than this, no file may be deleted.
const replicaStaleAfter = 36 * time.Hour

// archiveAlerts reduces the archive's own status to what the Memory page shows: a recipient set that differs
// from the pinned one, and a replication run that is missing or too old while segments exist.
func archiveAlerts(a *archive.Store, now time.Time) (admin.ArchiveAlerts, error) {
	st, err := a.Stats()
	if err != nil {
		return admin.ArchiveAlerts{}, err
	}
	rs, err := a.ReplicaStatus()
	if err != nil {
		return admin.ArchiveAlerts{}, err
	}
	pins, err := a.RecipientPins()
	if err != nil {
		return admin.ArchiveAlerts{}, err
	}
	out := admin.ArchiveAlerts{Segments: st.Segments, Unreplicated: rs.Unreplicated}
	for _, p := range pins {
		if p.Changed {
			out.RecipientChanges++
		}
	}
	if !rs.LastRunAt.IsZero() {
		t := rs.LastRunAt.UTC().Format(time.RFC3339)
		out.ReplicaLastRunAt = &t
	}
	out.ReplicaStale = replicaStale(st.Segments, rs.LastRunAt, now)
	return out, nil
}

// replicaStale: with segments stored, a replication run that never happened or is older than 36 h is an alert.
func replicaStale(segments int, lastRun, now time.Time) bool {
	return segments > 0 && (lastRun.IsZero() || now.Sub(lastRun) > replicaStaleAfter)
}
