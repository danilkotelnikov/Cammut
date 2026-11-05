// Package service holds the operations behind the console API. The HTTP handlers and, later, the assistant's
// admin tools call these same functions, so validation and auditing cannot differ between them.
package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"cammut/internal/store"
	"cammut/internal/upstream"
	"cammut/internal/vault"
)

var (
	ErrNotFound = errors.New("not found")
	ErrExists   = errors.New("already exists")
	ErrBadInput = errors.New("invalid input")
)

func bad(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrBadInput, fmt.Sprintf(format, a...))
}

// Actor says who is acting, for the audit log. Kind is "user" or "assistant".
type Actor struct{ Kind, Name, IP string }

func (a Actor) String() string { return a.Kind + ":" + a.Name }

type Service struct {
	st     *store.Store
	mgr    *upstream.Manager
	v      *vault.Vault
	getenv func(string) string
	Now    func() time.Time
}

// New also tells the manager to read named upstream secrets from the vault.
func New(st *store.Store, mgr *upstream.Manager, v *vault.Vault, getenv func(string) string) *Service {
	s := &Service{st: st, mgr: mgr, v: v, getenv: getenv, Now: time.Now}
	mgr.SetSecretResolver(func(name, purpose, host string) (string, error) {
		if _, exists := v.Policy(name); !exists {
			return "", nil // no such secret: the upstream's environment variable may serve
		}
		val, err := v.GetFor(name, purpose, host)
		if err != nil {
			return "", upstream.ErrSecretNotAllowed
		}
		return val, nil
	})
	return s
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

func kind(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrBadInput):
		return "invalid"
	case errors.Is(err, ErrNotFound):
		return "not found"
	case errors.Is(err, ErrExists):
		return "exists"
	}
	return "error"
}

// audit writes one admin row; target is a name, never a value.
func (s *Service) audit(a Actor, action, target string, err error) {
	note := clip(target, 80)
	if err != nil {
		note = clip(target+": "+kind(err), 120)
	}
	_ = s.st.AddAudit(store.Audit{TS: s.Now(), Upstream: "admin", Tool: action, OK: err == nil, Note: note, IP: a.IP, Actor: a.String()})
}

// AuditAction records one admin action done by another package (the memory and OAuth console routes): target is a name, never a value.
func (s *Service) AuditAction(a Actor, action, target string, err error) {
	s.audit(a, action, target, err)
}

// AuditAuth records one sign-in event: action is a fixed word (auth.login, auth.fail, auth.logout) and via is
// "password" or "github". Nothing the person typed is recorded, because a mistyped password often lands in the
// username field. actor is "user:<name>" when the person is known and empty for a failed attempt.
func (s *Service) AuditAuth(ip, actor, action string, ok bool, via string) {
	_ = s.st.AddAudit(store.Audit{TS: s.Now(), Upstream: "admin", Tool: action, OK: ok, Note: via, IP: ip, Actor: actor})
}

// Reload pushes the stored upstream list into the running manager at once.
func (s *Service) Reload() error {
	ups, err := s.st.ListUpstreams()
	if err != nil {
		return err
	}
	s.mgr.Set(ups)
	return nil
}

// ---- upstreams ----

type UpstreamView struct {
	Name         string `json:"name"`
	URL          string `json:"url"`
	BearerEnv    string `json:"bearer_env"`
	BearerSecret string `json:"bearer_secret"`
	AuthHeader   string `json:"auth_header"`
	SecretSet    bool   `json:"secret_set"`
	Enabled      bool   `json:"enabled"`
	Status       string `json:"status"` // ok, unreachable, checking, disabled
	Tools        int    `json:"tools"`
	LastError    string `json:"last_error"`
}

func (s *Service) secretSet(u store.Upstream) bool {
	if u.BearerSecret != "" {
		if _, ok, err := s.v.Get(u.BearerSecret); ok && err == nil {
			return true
		}
	}
	return u.BearerEnv != "" && s.getenv(u.BearerEnv) != ""
}

func (s *Service) Upstreams(ctx context.Context) ([]UpstreamView, error) {
	ups, err := s.st.ListUpstreams()
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()
	entries, errs := s.mgr.Entries(cctx, nil)
	counts := map[string]int{}
	for _, e := range entries {
		counts[e.Upstream]++
	}
	out := make([]UpstreamView, 0, len(ups))
	for _, u := range ups {
		v := UpstreamView{Name: u.Name, URL: u.URL, BearerEnv: u.BearerEnv, BearerSecret: u.BearerSecret, AuthHeader: u.AuthHeader, Enabled: u.Enabled, SecretSet: s.secretSet(u), Tools: counts[u.Name]}
		switch e := errs[u.Name]; {
		case !u.Enabled:
			v.Status = "disabled"
		case e == nil:
			v.Status = "ok"
		case errors.Is(e, context.DeadlineExceeded):
			v.Status = "checking"
		default:
			v.Status, v.LastError = "unreachable", clip(e.Error(), 200)
		}
		out = append(out, v)
	}
	return out, nil
}

func (s *Service) UpstreamAdd(a Actor, u store.Upstream) error {
	err := s.upstreamAdd(u)
	s.audit(a, "upstream.add", u.Name, err)
	return err
}

func (s *Service) upstreamAdd(u store.Upstream) error {
	if err := store.ValidateUpstream(u); err != nil {
		return bad("%v", err)
	}
	if _, ok, err := s.st.GetUpstream(u.Name); err != nil {
		return err
	} else if ok {
		return fmt.Errorf("%w: upstream %q", ErrExists, u.Name)
	}
	if err := s.st.AddUpstream(u); err != nil {
		return err
	}
	return s.Reload()
}

// UpstreamPatch changes only the fields that are set.
type UpstreamPatch struct {
	URL          *string
	BearerEnv    *string
	BearerSecret *string
	AuthHeader   *string
	Enabled      *bool
}

func (s *Service) UpstreamUpdate(a Actor, name string, p UpstreamPatch) error {
	err := s.upstreamUpdate(name, p)
	s.audit(a, "upstream.update", name, err)
	return err
}

func (s *Service) upstreamUpdate(name string, p UpstreamPatch) error {
	u, ok, err := s.st.GetUpstream(name)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: upstream %q", ErrNotFound, name)
	}
	if p.URL != nil {
		u.URL = *p.URL
	}
	if p.BearerEnv != nil {
		u.BearerEnv = *p.BearerEnv
	}
	if p.BearerSecret != nil {
		u.BearerSecret = *p.BearerSecret
	}
	if p.AuthHeader != nil {
		u.AuthHeader = *p.AuthHeader
	}
	if p.Enabled != nil {
		u.Enabled = *p.Enabled
	}
	if err := store.ValidateUpstream(u); err != nil {
		return bad("%v", err)
	}
	if err := s.st.AddUpstream(u); err != nil {
		return err
	}
	return s.Reload()
}

func (s *Service) UpstreamRemove(a Actor, name string) error {
	ok, err := s.st.RemoveUpstream(name)
	if err == nil && !ok {
		err = fmt.Errorf("%w: upstream %q", ErrNotFound, name)
	}
	if err == nil {
		err = s.Reload()
	}
	s.audit(a, "upstream.remove", name, err)
	return err
}

type TestResult struct {
	OK     bool     `json:"ok"`
	Tools  []string `json:"tools"`
	Millis int64    `json:"millis"`
	Error  string   `json:"error"`
}

// UpstreamTest connects with a fresh attempt and lists the tools; it changes nothing.
func (s *Service) UpstreamTest(ctx context.Context, a Actor, name string) (TestResult, error) {
	u, ok, err := s.st.GetUpstream(name)
	if err != nil {
		return TestResult{}, err
	}
	if !ok {
		return TestResult{}, fmt.Errorf("%w: upstream %q", ErrNotFound, name)
	}
	if !u.Enabled {
		return TestResult{Error: "upstream is disabled"}, nil
	}
	cctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	start := time.Now()
	entries, perr := s.mgr.Probe(cctx, name)
	res := TestResult{Millis: time.Since(start).Milliseconds(), Tools: []string{}}
	if perr != nil {
		res.Error = clip(perr.Error(), 200)
	} else {
		res.OK = true
		for _, e := range entries {
			res.Tools = append(res.Tools, e.Tool)
		}
	}
	s.audit(a, "upstream.test", name, perr)
	return res, nil
}

// ---- tokens ----

type TokenCreate struct {
	Label   string
	Scopes  []string
	Expires time.Duration // zero = never
	Profile string        // default "lazy"
}

func (s *Service) TokenCreate(a Actor, in TokenCreate) (string, store.Token, error) {
	plain, tok, err := s.tokenCreate(in)
	s.audit(a, "token.create", in.Label, err)
	return plain, tok, err
}

func (s *Service) tokenCreate(in TokenCreate) (string, store.Token, error) {
	if in.Expires < 0 || in.Expires > 365*24*time.Hour {
		return "", store.Token{}, bad("expiry must be between 0 and 365 days")
	}
	if in.Profile == "" {
		in.Profile = "lazy"
	}
	if _, ok, err := s.st.TokenByLabel(in.Label); err != nil {
		return "", store.Token{}, err
	} else if ok {
		return "", store.Token{}, fmt.Errorf("%w: token %q", ErrExists, in.Label)
	}
	var exp time.Time
	if in.Expires > 0 {
		exp = s.Now().Add(in.Expires)
	}
	plain, tok, err := s.st.CreateTokenOpts(in.Label, in.Scopes, exp, in.Profile)
	if err != nil {
		return "", store.Token{}, bad("%v", err)
	}
	return plain, tok, nil
}

func (s *Service) TokenSetScopes(a Actor, label string, scopes []string) error {
	ok, err := s.st.SetScopes(label, scopes)
	if err != nil {
		err = bad("%v", err)
	} else if !ok {
		err = fmt.Errorf("%w: active token %q", ErrNotFound, label)
	}
	s.audit(a, "token.scopes", label, err)
	return err
}

func (s *Service) TokenRevoke(a Actor, label string) error {
	ok, err := s.st.RevokeToken(label)
	if err == nil && !ok {
		err = fmt.Errorf("%w: active token %q", ErrNotFound, label)
	}
	s.audit(a, "token.revoke", label, err)
	return err
}

func (s *Service) Tokens() ([]store.Token, error) { return s.st.ListTokens() }

func (s *Service) Token(label string) (store.Token, bool, error) { return s.st.TokenByLabel(label) }

// ---- secrets ----

// SecretPut stores a value. A new secret needs a policy (purpose and allowed hosts); rotating an existing one keeps
// its policy, and passing a different policy for an existing secret is refused: use SecretSetPolicy.
func (s *Service) SecretPut(a Actor, name, value string, policy *vault.Policy) error {
	var err error
	_, exists := s.v.Policy(name)
	switch {
	case !vault.ValidName(name):
		err = bad("secret names look like GITHUB_PAT: capital letters, digits, underscore")
	case vault.ValidValue(value) != nil:
		err = bad("%v", vault.ValidValue(value))
	case !exists && policy == nil:
		err = bad("a new secret needs a purpose and the hosts it may be sent to")
	case policy != nil:
		if perr := s.v.PutWithPolicy(name, value, *policy); perr != nil {
			err = bad("%v", perr)
		}
	default:
		err = s.v.Put(name, value) // rotation: the stored policy stays
	}
	s.audit(a, "secret.put", name, err)
	return err
}

// SecretSetPolicy is the only way to change a secret's purpose or hosts after creation. The caller must type the
// secret's exact name as confirm. No assistant tool, MCP tool or token scope reaches it.
func (s *Service) SecretSetPolicy(a Actor, name string, policy vault.Policy, confirm string) error {
	var err error
	switch {
	case confirm != name:
		err = bad("type the secret's exact name to confirm")
	case a.Kind != "user":
		err = bad("only an administrator can change a secret policy")
	default:
		if perr := s.v.SetPolicy(name, policy); perr != nil {
			if _, ok := s.v.Policy(name); !ok {
				err = fmt.Errorf("%w: secret %q", ErrNotFound, name)
			} else {
				err = bad("%v", perr)
			}
		}
	}
	s.audit(a, "secret.policy", name+" "+policy.Purpose+" "+strings.Join(policy.Hosts, ","), err)
	return err
}

// BackfillSecretPolicies runs the one-time policy backfill and returns what it did.
func (s *Service) BackfillSecretPolicies() (store.BackfillResult, error) {
	return s.st.BackfillSecretPolicies()
}

func (s *Service) SecretDelete(a Actor, name string) error {
	ok, err := s.v.Delete(name)
	if err == nil && !ok {
		err = fmt.Errorf("%w: secret %q", ErrNotFound, name)
	}
	s.audit(a, "secret.delete", name, err)
	return err
}

func (s *Service) Secrets() ([]store.SecretMeta, error) { return s.v.Meta() }

// ---- audit ----

func (s *Service) AuditQuery(f store.AuditFilter) ([]store.Audit, error) { return s.st.QueryAudit(f) }
