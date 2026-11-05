package vault

import (
	"errors"
	"strings"
	"testing"
)

func TestASecretIsReleasedOnlyForItsPurposeAndListedHosts(t *testing.T) {
	v, _ := newVault(t)
	if err := v.PutWithPolicy("GITHUB_PAT", "ghp_secretvalue", Policy{Purpose: PurposeMCPBearer, Hosts: []string{"api.githubcopilot.com"}}); err != nil {
		t.Fatal(err)
	}
	if got, err := v.GetFor("GITHUB_PAT", PurposeMCPBearer, "api.githubcopilot.com"); err != nil || got != "ghp_secretvalue" {
		t.Fatalf("listed host and purpose: %q %v", got, err)
	}
	for name, c := range map[string][3]string{
		"other host":     {"GITHUB_PAT", PurposeMCPBearer, "evil.example"},
		"lookalike host": {"GITHUB_PAT", PurposeMCPBearer, "api.githubcopilot.com.evil.example"},
		"wrong purpose":  {"GITHUB_PAT", PurposeLLMKey, "api.githubcopilot.com"},
		"unknown secret": {"NOPE", PurposeMCPBearer, "api.githubcopilot.com"},
		"case trick":     {"GITHUB_PAT", PurposeMCPBearer, "API.GITHUBCOPILOT.COM.evil.example"},
		"empty host":     {"GITHUB_PAT", PurposeMCPBearer, ""},
		"port in host":   {"GITHUB_PAT", PurposeMCPBearer, "api.githubcopilot.com:443"},
	} {
		if got, err := v.GetFor(c[0], c[1], c[2]); !errors.Is(err, ErrNotAllowed) || got != "" {
			t.Errorf("%s: must be refused without revealing anything: %q %v", name, got, err)
		} else if strings.Contains(err.Error(), "githubcopilot") || strings.Contains(err.Error(), "GITHUB_PAT") {
			t.Errorf("%s: the refusal names the secret or its hosts: %v", name, err)
		}
	}
	if err := v.PutWithPolicy("OPENAI_API_KEY", "sk-providerkey", Policy{Purpose: PurposeLLMKey, Hosts: []string{"api.openai.com"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := v.GetFor("OPENAI_API_KEY", PurposeMCPBearer, "api.openai.com"); !errors.Is(err, ErrNotAllowed) {
		t.Fatal("a provider key can never be used as an MCP bearer, even toward its own host")
	}
	for name, p := range map[string]Policy{
		"bearer without a host": {Purpose: PurposeMCPBearer},
		"wildcard":              {Purpose: PurposeMCPBearer, Hosts: []string{"*.example.com"}},
		"port":                  {Purpose: PurposeLLMKey, Hosts: []string{"example.com:8443"}},
		"upper case":            {Purpose: PurposeLLMKey, Hosts: []string{"Example.com"}},
		"unknown purpose":       {Purpose: "anything", Hosts: []string{"example.com"}},
		"too many":              {Purpose: PurposeLLMKey, Hosts: []string{"a.a", "b.a", "c.a", "d.a", "e.a", "f.a", "g.a", "h.a", "i.a"}},
		"other with hosts":      {Purpose: PurposeOther, Hosts: []string{"example.com"}},
	} {
		if err := v.PutWithPolicy("X_"+strings.ToUpper(strings.ReplaceAll(name, " ", "_")), "v", p); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// IP literals are allowed only when typed explicitly (loopback providers need them).
	if err := v.PutWithPolicy("TEI_API_KEY", "v", Policy{Purpose: PurposeLLMKey, Hosts: []string{"127.0.0.1"}}); err != nil {
		t.Fatal(err)
	}
}

func TestPlainPutNeverCreatesATransmittableSecretAndRotationKeepsThePolicy(t *testing.T) {
	v, _ := newVault(t)
	if err := v.Put("LEGACY_KEY", "old"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.GetFor("LEGACY_KEY", PurposeLLMKey, "api.example.com"); !errors.Is(err, ErrNotAllowed) {
		t.Fatal("a secret without a policy has purpose other and is never transmitted")
	}
	v.PutWithPolicy("K", "v1", Policy{Purpose: PurposeLLMKey, Hosts: []string{"api.example.com"}})
	if err := v.Put("K", "v2"); err != nil { // value rotation
		t.Fatal(err)
	}
	if got, err := v.GetFor("K", PurposeLLMKey, "api.example.com"); err != nil || got != "v2" {
		t.Fatalf("rotation must keep the policy and change the value: %q %v", got, err)
	}
	p, ok := v.Policy("K")
	if !ok || p.Purpose != PurposeLLMKey || len(p.Hosts) != 1 {
		t.Fatalf("%+v %v", p, ok)
	}
	if err := v.SetPolicy("K", Policy{Purpose: PurposeLLMKey, Hosts: []string{"api.other.example"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := v.GetFor("K", PurposeLLMKey, "api.example.com"); !errors.Is(err, ErrNotAllowed) {
		t.Fatal("the old host must stop working at once")
	}
}
