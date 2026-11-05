package store

import (
	"encoding/json"
	"net/url"
	"sort"
	"strings"
)

const backfillKey = "secret_policy_backfill"

// BackfillResult says what the one-time policy backfill did (names only, never values).
type BackfillResult struct {
	Ran         bool
	Assigned    map[string]string // secret name -> purpose
	Quarantined []string          // referenced by more than one purpose: kept as "other", never transmitted
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// BackfillSecretPolicies gives every secret that has no explicit policy a derived one, exactly once, in one
// transaction: a secret named by an upstream's bearer_secret becomes mcp-upstream-bearer for that upstream's
// host(s); one named by an llm provider becomes llm-provider-key for that provider's host; the GitHub OAuth pair
// becomes oauth-client for github.com. A secret referenced for two purposes is quarantined as "other". Rows whose
// policy a person already fixed (policy_set=1) are never touched, and a finished backfill never runs again.
func (s *Store) BackfillSecretPolicies() (BackfillResult, error) {
	res := BackfillResult{Assigned: map[string]string{}}
	tx, err := s.db.Begin()
	if err != nil {
		return res, err
	}
	defer tx.Rollback()
	var done string
	_ = tx.QueryRow(`SELECT value FROM meta WHERE key=?`, backfillKey).Scan(&done)
	if done == "1" {
		return res, nil
	}
	type use struct {
		purposes map[string]bool
		hosts    map[string]bool
	}
	uses := map[string]*use{}
	add := func(name, purpose, host string) {
		if name == "" {
			return
		}
		u := uses[name]
		if u == nil {
			u = &use{purposes: map[string]bool{}, hosts: map[string]bool{}}
			uses[name] = u
		}
		u.purposes[purpose] = true
		if host != "" {
			u.hosts[host] = true
		}
	}
	rows, err := tx.Query(`SELECT bearer_secret,url FROM upstreams WHERE bearer_secret<>''`)
	if err != nil {
		return res, err
	}
	for rows.Next() {
		var n, u string
		if err := rows.Scan(&n, &u); err != nil {
			rows.Close()
			return res, err
		}
		add(n, "mcp-upstream-bearer", hostOf(u))
	}
	rows.Close()
	rows, err = tx.Query(`SELECT secret_name,base_url FROM llm_providers WHERE secret_name<>''`)
	if err != nil {
		return res, err
	}
	for rows.Next() {
		var n, u string
		if err := rows.Scan(&n, &u); err != nil {
			rows.Close()
			return res, err
		}
		add(n, "llm-provider-key", hostOf(u))
	}
	rows.Close()
	add("GITHUB_OAUTH_CLIENT_ID", "oauth-client", "github.com")
	add("GITHUB_OAUTH_CLIENT_SECRET", "oauth-client", "github.com")

	rows, err = tx.Query(`SELECT name FROM secrets WHERE policy_set=0`)
	if err != nil {
		return res, err
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return res, err
		}
		names = append(names, n)
	}
	rows.Close()
	for _, n := range names {
		purpose, hosts := "other", []string{}
		if u := uses[n]; u != nil {
			if len(u.purposes) > 1 {
				res.Quarantined = append(res.Quarantined, n)
			} else {
				for p := range u.purposes {
					purpose = p
				}
				for h := range u.hosts {
					hosts = append(hosts, h)
				}
				sort.Strings(hosts)
				if len(hosts) > 8 {
					hosts = hosts[:8]
				}
			}
		}
		if purpose != "other" && len(hosts) == 0 {
			purpose = "other"
		}
		hj, _ := json.Marshal(hosts)
		if _, err := tx.Exec(`UPDATE secrets SET purpose=?, allowed_hosts=?, policy_set=1 WHERE name=?`, purpose, string(hj), n); err != nil {
			return res, err
		}
		res.Assigned[n] = purpose
	}
	if _, err := tx.Exec(`INSERT INTO meta(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value='1'`, backfillKey); err != nil {
		return res, err
	}
	if err := tx.Commit(); err != nil {
		return res, err
	}
	res.Ran = true
	sort.Strings(res.Quarantined)
	return res, nil
}
