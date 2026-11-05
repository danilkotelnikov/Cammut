package vault

import (
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
)

// Purposes a secret can be stored for. "other" can be stored but no code path in Cammut ever transmits it.
const (
	PurposeMCPBearer = "mcp-upstream-bearer"
	PurposeLLMKey    = "llm-provider-key"
	PurposeOAuth     = "oauth-client"
	PurposeOther     = "other"
	maxHosts         = 8
)

// ErrNotAllowed is returned when a secret is missing, has another purpose, or the host is not on its list.
// It names nothing: no secret name, no host list.
var ErrNotAllowed = errors.New("secret not allowed for this purpose and host")

// Policy fixes where a secret may go: a purpose and exact lower-case host names (no wildcards, no ports).
type Policy struct {
	Purpose string
	Hosts   []string
}

var hostRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// ValidPolicy checks purpose and host list.
func ValidPolicy(p Policy) error {
	switch p.Purpose {
	case PurposeMCPBearer, PurposeLLMKey, PurposeOAuth:
		if len(p.Hosts) == 0 {
			return fmt.Errorf("purpose %s needs at least one allowed host", p.Purpose)
		}
	case PurposeOther:
		if len(p.Hosts) != 0 {
			return errors.New("purpose other takes no hosts")
		}
	default:
		return fmt.Errorf("unknown purpose %q", p.Purpose)
	}
	if len(p.Hosts) > maxHosts {
		return fmt.Errorf("at most %d hosts", maxHosts)
	}
	seen := map[string]bool{}
	for _, h := range p.Hosts {
		if len(h) > 253 {
			return errors.New("host too long")
		}
		if _, err := netip.ParseAddr(h); err != nil && (!hostRe.MatchString(h) || strings.ContainsAny(h, "*:/@")) {
			return fmt.Errorf("host %q must be an exact lower-case host name (no wildcard, port or path)", h)
		}
		if seen[h] {
			return fmt.Errorf("host %q listed twice", h)
		}
		seen[h] = true
	}
	return nil
}

// PutWithPolicy creates a secret with its policy. If the secret already exists the value is rotated and the stored
// policy must equal p: a policy is changed only with SetPolicy.
func (v *Vault) PutWithPolicy(name, value string, p Policy) error {
	if !ValidName(name) {
		return fmt.Errorf("invalid secret name %q", name)
	}
	if err := ValidValue(value); err != nil {
		return err
	}
	if err := ValidPolicy(p); err != nil {
		return err
	}
	if old, ok := v.Policy(name); ok && !samePolicy(old, p) {
		return errors.New("secret exists with another policy: change it with the policy command")
	}
	blob := v.SealBlob([]byte(value), secretAAD(name))
	n := v.aead.NonceSize()
	return v.st.PutSecretPolicy(name, blob[:n], blob[n:], p.Purpose, p.Hosts, timeNow())
}

func samePolicy(a, b Policy) bool {
	if a.Purpose != b.Purpose || len(a.Hosts) != len(b.Hosts) {
		return false
	}
	m := map[string]bool{}
	for _, h := range a.Hosts {
		m[h] = true
	}
	for _, h := range b.Hosts {
		if !m[h] {
			return false
		}
	}
	return true
}

// Policy returns the stored policy of a secret.
func (v *Vault) Policy(name string) (Policy, bool) {
	purpose, hosts, _, ok, err := v.st.SecretPolicy(name)
	if err != nil || !ok {
		return Policy{}, false
	}
	return Policy{Purpose: purpose, Hosts: hosts}, true
}

// SetPolicy replaces the policy of an existing secret (the caller has checked the typed confirmation).
func (v *Vault) SetPolicy(name string, p Policy) error {
	if err := ValidPolicy(p); err != nil {
		return err
	}
	ok, err := v.st.SetSecretPolicy(name, p.Purpose, p.Hosts)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("no secret named %q", name)
	}
	return nil
}

// GetFor releases the value only when the secret's purpose equals purpose and host is on its list. Every
// transmission point calls this on every request, so a policy change takes effect at once.
func (v *Vault) GetFor(name, purpose, host string) (string, error) {
	p, ok := v.Policy(name)
	host = strings.ToLower(host)
	if !ok || p.Purpose != purpose || purpose == PurposeOther || host == "" {
		return "", ErrNotAllowed
	}
	listed := false
	for _, h := range p.Hosts {
		if h == host {
			listed = true
		}
	}
	if !listed {
		return "", ErrNotAllowed
	}
	val, found, err := v.Get(name)
	if err != nil || !found {
		return "", ErrNotAllowed
	}
	return val, nil
}
