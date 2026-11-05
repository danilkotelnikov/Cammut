package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"cammut/internal/admin"
	"cammut/internal/archive"
	"cammut/internal/archiveapi"
	"cammut/internal/auth"
	"cammut/internal/gateway"
	"cammut/internal/memory"
	"cammut/internal/memoryapi"
	"cammut/internal/memorymcp"
	"cammut/internal/ratelimit"
	"cammut/internal/store"
	"cammut/internal/upstream"
	"cammut/internal/version"
	"cammut/internal/web"
)

const usage = `usage: cammut <command>
  serve    -db PATH -listen ADDR [-rate N] [-burst N]
  token    create -label L -scopes a/*,b/tool [-profile lazy|direct:UPSTREAM] | scopes -label L -scopes ... | list | revoke -label L
  upstream add -name N -url U [-bearer-env VAR] | list | rm -name N
  admin    vault-init | create -username U [-generate] | passwd | totp-reset | github-link | secret set|policy|list|delete | db-snapshot -out PATH [-keep N]
  archive  stats | verify [-sample N] [-project P] | list [-project P] [-limit N] | replica-record -remote NAME < manifest.json | pins [ack -project P]
  version`

func defaultDB() string {
	if v := os.Getenv("CAMMUT_DB"); v != "" {
		return v
	}
	return "/var/lib/cammut/cammut.db"
}

func run(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	switch args[0] {
	case "serve":
		return serve(args[1:])
	case "token":
		return tokenCmd(args[1:], out)
	case "upstream":
		return upstreamCmd(args[1:], out)
	case "admin":
		return adminCmd(args[1:], out)
	case "archive":
		return archiveCmd(args[1:], out)
	case "version":
		fmt.Fprintln(out, version.Version)
		return nil
	default:
		return errors.New(usage)
	}
}

func splitScopes(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func tokenCmd(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("token: need create|scopes|list|revoke")
	}
	fs := flag.NewFlagSet("token "+args[0], flag.ContinueOnError)
	db := fs.String("db", defaultDB(), "sqlite path")
	label := fs.String("label", "", "token label")
	scopes := fs.String("scopes", "", "comma-separated scopes (empty = no access)")
	profile := fs.String("profile", "lazy", "tool profile: lazy (four meta-tools) or direct:UPSTREAM (that upstream's tools listed natively, e.g. direct:memory for Warp)")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	st, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer st.Close()
	switch args[0] {
	case "create":
		plain, tok, err := st.CreateTokenOpts(*label, splitScopes(*scopes), time.Time{}, *profile)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "label:   %s\nscopes:  %s\nprofile: %s\ntoken:   %s\n(shown once; store it now, only its hash is kept)\n", tok.Label, strings.Join(tok.Scopes, ","), tok.Profile, plain)
	case "scopes":
		ok, err := st.SetScopes(*label, splitScopes(*scopes))
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("no active token with label %q", *label)
		}
		fmt.Fprintf(out, "%s now has scopes: %s\n", *label, strings.Join(splitScopes(*scopes), ","))
	case "list":
		toks, err := st.ListTokens()
		if err != nil {
			return err
		}
		for _, t := range toks {
			state := "active"
			if t.Revoked {
				state = "revoked"
			}
			last := "never"
			if !t.LastUsedAt.IsZero() {
				last = t.LastUsedAt.Format(time.RFC3339)
			}
			fmt.Fprintf(out, "%-20s %-8s last used %-25s scopes %s\n", t.Label, state, last, strings.Join(t.Scopes, ","))
		}
	case "revoke":
		ok, err := st.RevokeToken(*label)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("no active token with label %q", *label)
		}
		fmt.Fprintf(out, "revoked %s\n", *label)
	default:
		return fmt.Errorf("token: unknown subcommand %q", args[0])
	}
	return nil
}

func upstreamCmd(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("upstream: need add|list|rm")
	}
	fs := flag.NewFlagSet("upstream "+args[0], flag.ContinueOnError)
	db := fs.String("db", defaultDB(), "sqlite path")
	name := fs.String("name", "", "upstream name")
	url := fs.String("url", "", "upstream MCP endpoint")
	env := fs.String("bearer-env", "", "environment variable holding the upstream bearer token")
	disabled := fs.Bool("disabled", false, "register but keep disabled")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	st, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer st.Close()
	switch args[0] {
	case "add":
		if err := st.AddUpstream(store.Upstream{Name: *name, URL: *url, BearerEnv: *env, Enabled: !*disabled}); err != nil {
			return err
		}
		fmt.Fprintf(out, "upstream %s saved\n", *name)
	case "list":
		ups, err := st.ListUpstreams()
		if err != nil {
			return err
		}
		for _, u := range ups {
			fmt.Fprintf(out, "%-16s enabled=%-5v bearer_env=%-24s %s\n", u.Name, u.Enabled, u.BearerEnv, u.URL)
		}
	case "rm":
		ok, err := st.RemoveUpstream(*name)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("no upstream named %q", *name)
		}
		fmt.Fprintf(out, "removed %s\n", *name)
	default:
		return fmt.Errorf("upstream: unknown subcommand %q", args[0])
	}
	return nil
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	db := fs.String("db", defaultDB(), "sqlite path")
	listen := fs.String("listen", "127.0.0.1:7421", "listen address")
	rate := fs.Float64("rate", 20, "requests per second per token")
	burst := fs.Int("burst", 40, "burst per token")
	keyPath := fs.String("vault-key", defaultKeyPath(), "vault key file; the console is disabled when it cannot be loaded")
	siteOrigin := fs.String("site-origin", "", "public origin of the console, e.g. https://cammut.example.org (mounts the console on -listen)")
	adminListen := fs.String("admin-listen", "", "private console listener, e.g. 127.0.0.1:7422 (reach it through SSH)")
	archiveDir := fs.String("archive-dir", "/data/archive", "directory for age-encrypted raw archive segments")
	archiveMax := fs.Int64("archive-max-bytes", 21474836480, "archive quota in bytes")
	archiveMinFree := fs.Int64("archive-min-free", 5368709120, "refuse archive writes when free disk space would drop below this many bytes")
	teiURL := fs.String("tei-url", "", "text-embeddings-inference base URL for note vectors (key in env TEI_API_KEY); empty = recall is full-text only")
	teiModel := fs.String("tei-model", "paraphrase-multilingual-MiniLM-L12-v2", "label stored with each vector; vectors of another label are ignored")
	publicLogin := fs.Bool("public-login", false, "allow password and GitHub login on -listen; only safe once real client addresses reach the server")
	publicLoginGitHub := fs.Bool("public-login-github-only", false, "allow GitHub sign-in (not the password form) on -listen; safe behind a proxy that hides client addresses, because no password can be guessed")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *adminListen != "" {
		if err := checkAdminListen(*adminListen); err != nil {
			return err
		}
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	st, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer st.Close()

	mgr := upstream.NewManager(os.Getenv)
	reload := func() {
		ups, err := st.ListUpstreams()
		if err != nil {
			log.Error("reload upstreams", "err", err)
			return
		}
		mgr.Set(ups)
	}
	reload()

	parts, aerr := buildAdmin(st, mgr, *keyPath)
	if aerr != nil {
		log.Error("console disabled: the gateway keeps running but no console endpoint is served", "reason", aerr.Error())
	}

	memStore := memory.NewStore(st.DB(), nil)
	var emb memory.Embedder
	if *teiURL != "" {
		emb = memory.NewTEI(*teiURL, os.Getenv("TEI_API_KEY"), *teiModel, nil)
	} else {
		log.Info("memory: no -tei-url, recall is full-text only")
	}
	ranker := memory.NewRanker(memStore, emb, log)
	if v := os.Getenv("CAMMUT_RECALL_GATE"); v != "" { // "base,short,long": cosine bars of the relevance gate, see docs/MEMORY-GATES.md
		if g, err := memory.ParseGate(v); err != nil {
			log.Error("memory: CAMMUT_RECALL_GATE ignored, using the defaults", "err", err.Error())
		} else {
			ranker.Gate = g
		}
	}
	memSvc := memory.NewService(memStore, ranker, func(a store.Audit) {
		if err := st.AddAudit(a); err != nil {
			log.Error("audit write failed", "err", err)
		}
	}, nil)
	defer memSvc.Wait() // runs before the store closes: finish embedding the notes just written
	mgr.SetLocal("memory", memorymcp.Connector(memorymcp.New(memSvc)))
	if parts != nil {
		parts.mem = memSvc
	}

	prune := func() {
		if n, err := st.PruneAudit(time.Now().Add(-90 * 24 * time.Hour)); err != nil {
			log.Error("prune audit", "err", err)
		} else if n > 0 {
			log.Info("pruned audit rows", "n", n)
		}
		if _, err := st.PruneSessions(time.Now()); err != nil {
			log.Error("prune sessions", "err", err)
		}
		if _, err := memStore.PruneDeliveries(time.Now().Add(-30 * 24 * time.Hour)); err != nil {
			log.Error("prune memory deliveries", "err", err)
		}
	}
	prune() // a restart-happy host must not skip the daily prune

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	bgDone := make(chan struct{})
	go func() {
		defer close(bgDone)
		tick, daily := time.NewTicker(15*time.Second), time.NewTicker(24*time.Hour)
		defer tick.Stop()
		defer daily.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				reload()
			case <-daily.C:
				prune()
			}
		}
	}()

	deps := gateway.Deps{Store: st, Mgr: mgr, Limiter: ratelimit.New(*rate, *burst), Log: log, Memory: memoryapi.New(memSvc, log)}
	if parts != nil {
		backfillPolicies(parts, log)
	}
	var alerts func() (admin.ArchiveAlerts, error) // stays nil while the archive is disabled
	if arch, err := archive.New(st.DB(), *archiveDir, *archiveMax, *archiveMinFree, nil); err != nil {
		log.Error("archive disabled: the gateway keeps running but no archive endpoint is served", "reason", err.Error())
	} else {
		rep, err := arch.Reconcile()
		if err != nil {
			log.Error("archive reconcile failed", "err", err.Error())
		}
		log.Info(fmt.Sprintf("archive reconcile: temp=%d missing=%d", rep.TempRemoved, len(rep.Missing)), "checked", rep.Checked)
		deps.Archive = archiveapi.New(arch, st, log)
		alerts = func() (admin.ArchiveAlerts, error) { return archiveAlerts(arch, time.Now()) }
	}
	if parts != nil {
		parts.alert = alerts
		parts.siteOrigin = *siteOrigin
	}
	if parts != nil && *siteOrigin != "" {
		oa := parts.oauth
		deps.Admin = admin.New(admin.Config{
			Auth: parts.auth, Svc: parts.svc, Throttle: auth.NewThrottle(nil), Origins: []string{*siteOrigin}, SiteOrigin: *siteOrigin,
			LoginEnabled: *publicLogin || *publicLoginGitHub, GitHubOnly: *publicLoginGitHub && !*publicLogin,
			GitHub: githubConfig(parts, *siteOrigin), Memory: memSvc, OAuth: oa, ArchiveAlerts: alerts, Log: log,
		})
		deps.Console = web.Handler()
		deps.OAuth = oa.Handler(*siteOrigin)
		deps.PublicURL = *siteOrigin
	}
	servers := []*http.Server{newServer(*listen, gateway.Handler(deps))}
	if parts != nil && *adminListen != "" {
		servers = append(servers, newServer(*adminListen, privateHandler(parts, *adminListen, log)))
	}

	errc := make(chan error, len(servers)+1)
	for _, s := range servers {
		go func(s *http.Server) {
			log.Info("cammut listening", "addr", s.Addr, "version", version.Version, "console", parts != nil)
			errc <- s.ListenAndServe()
		}(s)
	}
	var firstErr error
	select {
	case <-ctx.Done():
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			firstErr = err
		}
		stop()
	}
	// Shutdown returns once in-flight handlers finish; only then may the deferred store close run.
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(sctx)
	}
	<-bgDone
	return firstErr
}
