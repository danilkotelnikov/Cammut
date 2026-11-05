package main

import (
	"bufio"
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
	"rsc.io/qr"

	"cammut/internal/auth"
	"cammut/internal/store"
	"cammut/internal/vault"
)

// readPassword reads a line from the terminal without echo. It is a variable so tests can replace it.
var readPassword = func(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", errors.New("this command needs an interactive terminal (use ssh -t, or docker run -it)")
	}
	return string(b), nil
}

// readLine reads one visible line (a typed confirmation). It is a variable so tests can replace it.
var readLine = func(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return "", errors.New("this command needs an interactive terminal")
	}
	return strings.TrimSpace(line), nil
}

var githubAPI = "https://api.github.com"

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func decodeSecret(s string) ([]byte, error) { return b32.DecodeString(s) }

func defaultKeyPath() string {
	if v := os.Getenv("CAMMUT_VAULT_KEY"); v != "" {
		return v
	}
	return "/etc/cammut/vault.key"
}

func adminCmd(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("admin: need vault-init|create|passwd|totp-reset|github-link|secret|db-snapshot")
	}
	sub, rest := args[0], args[1:]
	var secretAction string
	if sub == "secret" {
		if len(rest) == 0 {
			return errors.New("admin secret: need set NAME -purpose P -hosts H | policy NAME -purpose P -hosts H | list | delete NAME")
		}
		secretAction, rest = rest[0], rest[1:]
	}
	var secretName string
	if secretAction == "set" || secretAction == "delete" || secretAction == "policy" {
		if len(rest) == 0 || strings.HasPrefix(rest[0], "-") {
			return fmt.Errorf("admin secret %s: need a NAME", secretAction)
		}
		secretName, rest = rest[0], rest[1:]
	}
	fs := flag.NewFlagSet("admin "+sub, flag.ContinueOnError)
	db := fs.String("db", defaultDB(), "sqlite path")
	keyPath := fs.String("key", defaultKeyPath(), "vault key file")
	username := fs.String("username", "", "admin username")
	generate := fs.Bool("generate", false, "generate a password instead of prompting")
	login := fs.String("login", "", "GitHub login")
	snapOut := fs.String("out", "", "db-snapshot: file to write (must not exist)")
	purpose := fs.String("purpose", "", "secret set/policy: mcp-upstream-bearer | llm-provider-key | oauth-client | other")
	hostsFlag := fs.String("hosts", "", "secret set/policy: comma-separated exact host names the secret may be sent to")
	snapKeep := fs.Int("keep", 0, "db-snapshot: keep only the newest N cammut-*.db files in the directory (0 = keep all)")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if sub == "db-snapshot" {
		return dbSnapshot(out, *db, *snapOut, *snapKeep)
	}
	if sub == "vault-init" {
		if err := vault.InitKey(*keyPath); err != nil {
			return err
		}
		fmt.Fprintf(out, "created %s (mode 0400)\nBack it up somewhere safe and separate: without it every stored secret is unreadable.\n", *keyPath)
		return nil
	}
	key, err := vault.LoadKey(*keyPath)
	if err != nil {
		return err
	}
	st, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer st.Close()
	v, err := vault.New(key, st)
	if err != nil {
		return err
	}
	a, err := auth.New(st, v, auth.NewHasher(1, 0))
	if err != nil {
		return err
	}
	switch sub {
	case "create":
		if *username == "" {
			return errors.New("admin create: -username is required")
		}
		pw, err := chooseNewPassword(out, *generate)
		if err != nil {
			return err
		}
		enr, err := a.CreateUser(*username, pw)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "created user %s\n", *username)
		printEnrollment(out, enr)
	case "passwd":
		if *username == "" {
			return errors.New("admin passwd: -username is required")
		}
		pw, err := chooseNewPassword(out, false)
		if err != nil {
			return err
		}
		if err := a.SetPassword(*username, pw); err != nil {
			return err
		}
		fmt.Fprintln(out, "password changed; every session of this user was ended")
	case "totp-reset":
		if *username == "" {
			return errors.New("admin totp-reset: -username is required")
		}
		enr, err := a.ResetTOTP(*username)
		if err != nil {
			return err
		}
		fmt.Fprintln(out, "authenticator reset; every session was ended and the old recovery codes are void")
		printEnrollment(out, enr)
	case "github-link":
		if *username == "" || *login == "" {
			return errors.New("admin github-link: -username and -login are required")
		}
		id, err := githubUserID(*login)
		if err != nil {
			return err
		}
		if err := a.LinkGitHub(*username, id); err != nil {
			return err
		}
		fmt.Fprintf(out, "linked GitHub login %s (numeric id %d) to %s\n", *login, id, *username)
	case "secret":
		return secretCmd(out, v, secretAction, secretName, *purpose, *hostsFlag)
	default:
		return fmt.Errorf("admin: unknown subcommand %q", sub)
	}
	return nil
}

func chooseNewPassword(out io.Writer, generate bool) (string, error) {
	if generate {
		pw := generatePassphrase()
		fmt.Fprintf(out, "password: %s\n(shown once; store it in your password manager)\n", pw)
		return pw, nil
	}
	p1, err := readPassword("New password (min 14 characters): ")
	if err != nil {
		return "", err
	}
	p2, err := readPassword("Repeat password: ")
	if err != nil {
		return "", err
	}
	if p1 != p2 {
		return "", errors.New("the two passwords differ")
	}
	return p1, nil
}

// generatePassphrase returns 130 bits as five groups of five symbols.
func generatePassphrase() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 25)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = alphabet[b[i]&31]
	}
	var parts []string
	for i := 0; i < 25; i += 5 {
		parts = append(parts, string(b[i:i+5]))
	}
	return strings.Join(parts, "-")
}

func printEnrollment(out io.Writer, e auth.Enrollment) {
	fmt.Fprintln(out, "\nScan this with an authenticator app (or type the secret):")
	if err := printQR(out, e.URI); err != nil {
		fmt.Fprintf(out, "(could not draw a QR code: %v)\n", err)
	}
	fmt.Fprintf(out, "secret: %s\nuri:    %s\n", e.Secret, e.URI)
	fmt.Fprintln(out, "\nRecovery codes (each works once; shown once; keep them offline):")
	for _, c := range e.RecoveryCodes {
		fmt.Fprintf(out, "  %s\n", c)
	}
}

func printQR(w io.Writer, text string) error {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return err
	}
	const quiet = 2
	for y := -quiet; y < code.Size+quiet; y++ {
		for x := -quiet; x < code.Size+quiet; x++ {
			if x >= 0 && y >= 0 && x < code.Size && y < code.Size && code.Black(x, y) {
				fmt.Fprint(w, "\x1b[40m  \x1b[0m")
			} else {
				fmt.Fprint(w, "\x1b[47m  \x1b[0m")
			}
		}
		fmt.Fprintln(w)
	}
	return nil
}

func githubUserID(login string) (int64, error) {
	c := &http.Client{Timeout: 10 * time.Second}
	resp, err := c.Get(githubAPI + "/users/" + url.PathEscape(login))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("GitHub answered %s for login %q", resp.Status, login)
	}
	var u struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&u); err != nil || u.ID == 0 {
		return 0, fmt.Errorf("unexpected GitHub answer for %q", login)
	}
	return u.ID, nil
}

func parseHosts(csv string) []string {
	var hs []string
	for _, h := range strings.Split(csv, ",") {
		if h = strings.TrimSpace(h); h != "" {
			hs = append(hs, h)
		}
	}
	return hs
}

func secretCmd(out io.Writer, v *vault.Vault, action, name, purpose, hostsCSV string) error {
	pol := vault.Policy{Purpose: purpose, Hosts: parseHosts(hostsCSV)}
	switch action {
	case "set":
		if !vault.ValidName(name) {
			return fmt.Errorf("invalid secret name %q (use UPPER_CASE letters, digits, underscore)", name)
		}
		_, exists := v.Policy(name)
		if !exists || purpose != "" {
			if err := vault.ValidPolicy(pol); err != nil {
				return fmt.Errorf("a new secret needs -purpose and -hosts: %w", err)
			}
		}
		val, err := readPassword("Value for " + name + " (hidden): ")
		if err != nil {
			return err
		}
		if exists && purpose == "" {
			err = v.Put(name, val) // rotation keeps the stored policy
		} else {
			err = v.PutWithPolicy(name, val, pol)
		}
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "stored %s\n", name)
	case "policy":
		if _, ok := v.Policy(name); !ok {
			return fmt.Errorf("no secret named %q", name)
		}
		if err := vault.ValidPolicy(pol); err != nil {
			return err
		}
		typed, err := readLine("Type the secret name " + name + " to confirm the new purpose and hosts: ")
		if err != nil {
			return err
		}
		if typed != name {
			return errors.New("confirmation does not match the secret name: nothing changed")
		}
		if err := v.SetPolicy(name, pol); err != nil {
			return err
		}
		fmt.Fprintf(out, "policy of %s: %s -> %s\n", name, pol.Purpose, strings.Join(pol.Hosts, ","))
	case "list":
		meta, err := v.Meta()
		if err != nil {
			return err
		}
		for _, m := range meta {
			fmt.Fprintf(out, "%-32s %-20s %-30s updated %s\n", m.Name, m.Purpose, strings.Join(m.Hosts, ","), m.UpdatedAt.Format(time.RFC3339))
		}
	case "delete":
		ok, err := v.Delete(name)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("no secret named %q", name)
		}
		fmt.Fprintf(out, "deleted %s\n", name)
	default:
		return fmt.Errorf("admin secret: unknown action %q", action)
	}
	return nil
}
