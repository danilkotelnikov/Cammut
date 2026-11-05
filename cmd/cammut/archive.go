package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"cammut/internal/archive"
	"cammut/internal/store"
)

// archiveStdin is where replica-record reads its manifest; tests replace it.
var archiveStdin io.Reader = os.Stdin

const maxManifest = 64 << 20

// archiveCmd runs against the database and the archive directory like the other subcommands: there is no HTTP route
// and no token that can record a replica or acknowledge a recipient change.
func archiveCmd(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("archive: need stats|verify|list|replica-record|pins")
	}
	sub, rest := args[0], args[1:]
	action := ""
	if sub == "pins" && len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		action, rest = rest[0], rest[1:]
	}
	fs := flag.NewFlagSet("archive "+sub, flag.ContinueOnError)
	db := fs.String("db", defaultDB(), "sqlite path")
	dir := fs.String("archive-dir", "/data/archive", "archive directory")
	project := fs.String("project", "", "limit to one project")
	sample := fs.Int("sample", 0, "verify: check a random sample of N segments instead of all")
	limit := fs.Int("limit", 50, "list: newest N segments")
	remote := fs.String("remote", "", "replica-record: name of the offsite remote")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	st, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer st.Close()
	a, err := archive.New(st.DB(), *dir, 0, 0, nil)
	if err != nil {
		return err
	}
	switch sub {
	case "stats":
		s, err := a.Stats()
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "segments    %d\ncipher MiB  %.1f\nsessions    %d\nfree GiB    %.1f\n", s.Segments, float64(s.CipherBytes)/(1<<20), s.Sessions, float64(s.FreeBytes)/(1<<30))
		names := make([]string, 0, len(s.ByProject))
		for p := range s.ByProject {
			names = append(names, p)
		}
		sort.Strings(names)
		for _, p := range names {
			fmt.Fprintf(out, "project     %-24s %.1f MiB\n", p, float64(s.ByProject[p])/(1<<20))
		}
		rs, err := a.ReplicaStatus()
		if err != nil {
			return err
		}
		last := "never"
		if !rs.LastRunAt.IsZero() {
			last = rs.LastRunAt.UTC().Format(time.RFC3339)
		}
		fmt.Fprintf(out, "replica     last run %s, replicated %d, unreplicated %d\n", last, rs.Replicated, rs.Unreplicated)
	case "verify":
		ids, err := a.IDs(*project)
		if err != nil {
			return err
		}
		if *sample > 0 && *sample < len(ids) {
			rand.Shuffle(len(ids), func(i, j int) { ids[i], ids[j] = ids[j], ids[i] })
			ids = ids[:*sample]
		}
		var ok, missing, corrupt int
		for _, id := range ids {
			switch r, err := a.Verify(id); {
			case errors.Is(err, archive.ErrNotFound):
				missing++
			case err != nil:
				return err
			case r == "ok":
				ok++
			case r == "missing":
				missing++
			default:
				corrupt++
			}
		}
		fmt.Fprintf(out, "ok %d / missing %d / corrupt %d\n", ok, missing, corrupt)
		if missing+corrupt > 0 {
			return fmt.Errorf("archive verify: %d missing, %d corrupt", missing, corrupt)
		}
	case "list":
		segs, err := a.List(archive.ListFilter{Project: *project, Limit: *limit})
		if err != nil {
			return err
		}
		for _, g := range segs {
			fmt.Fprintf(out, "%s %-12s %-16s %-24s %-10s %d-%d %d B %s\n", g.ID, g.Agent, g.Project, g.SessionID, g.Kind, g.SrcStart, g.SrcEnd, g.CipherBytes, g.StoredAt.UTC().Format(time.RFC3339))
		}
	case "replica-record":
		if *remote == "" {
			return errors.New("archive replica-record: -remote is required")
		}
		var m struct {
			Items []archive.ReplicaItem `json:"items"`
		}
		if err := json.NewDecoder(io.LimitReader(archiveStdin, maxManifest)).Decode(&m); err != nil {
			return fmt.Errorf("archive replica-record: manifest on stdin is not valid JSON")
		}
		res, err := a.RecordReplica(*remote, m.Items)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "verified %d rejected %d\n", res.Verified, res.Rejected)
		if res.Rejected > 0 {
			return fmt.Errorf("archive replica-record: %d items rejected (unknown id or sha differs from the stored ciphertext)", res.Rejected)
		}
	case "pins":
		switch action {
		case "":
			pins, err := a.RecipientPins()
			if err != nil {
				return err
			}
			for _, p := range pins {
				state := "ok"
				if p.Changed {
					state = "CHANGED to " + p.LastChangedTo + " at " + p.ChangedAt.UTC().Format(time.RFC3339)
				}
				fmt.Fprintf(out, "%-24s pinned %s  %s\n", p.Project, p.Fingerprints, state)
			}
		case "ack":
			if *project == "" {
				return errors.New("archive pins ack: -project is required")
			}
			done, err := a.AckPin(*project)
			if err != nil {
				return err
			}
			if !done {
				return fmt.Errorf("archive pins ack: project %q has no unacknowledged change", *project)
			}
			fmt.Fprintf(out, "re-pinned %s to the current recipient set\n", *project)
		default:
			return fmt.Errorf("archive pins: unknown action %q", action)
		}
	default:
		return fmt.Errorf("archive: unknown subcommand %q", sub)
	}
	return nil
}

var snapshotName = regexp.MustCompile(`^cammut-[A-Za-z0-9._-]+\.db$`)

// dbSnapshot writes one consistent copy of the live database and keeps only the newest `keep` snapshots in its
// directory (the container image has no shell to do that). The new file is never removed.
func dbSnapshot(out io.Writer, db, path string, keep int) error {
	if path == "" {
		return errors.New("admin db-snapshot: -out is required")
	}
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("admin db-snapshot: %s already exists", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	st, err := store.Open(db)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Snapshot(path); err != nil {
		os.Remove(path)
		return err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "snapshot written (%d bytes)\n", fi.Size())
	if keep > 0 {
		entries, err := os.ReadDir(filepath.Dir(path))
		if err != nil {
			return err
		}
		var names []string
		for _, e := range entries {
			if e.Type().IsRegular() && snapshotName.MatchString(e.Name()) && e.Name() != filepath.Base(path) {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names) // the stamp in the name sorts oldest first
		for i := 0; i < len(names)-(keep-1); i++ {
			_ = os.Remove(filepath.Join(filepath.Dir(path), names[i]))
		}
	}
	return nil
}
