package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"cammut/internal/archive"
	"cammut/internal/store"
)

func ageLike(payload string) []byte {
	return []byte("age-encryption.org/v1\n-> X25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n--- CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n" + payload)
}

func sha(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// seeded returns a database path and an archive directory holding two segments of the project "Cammut".
func seeded(t *testing.T) (db, dir string, ids []string) {
	t.Helper()
	base := t.TempDir()
	db, dir = filepath.Join(base, "c.db"), filepath.Join(base, "archive")
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	a, err := archive.New(st.DB(), dir, 1<<30, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		m := archive.Meta{Agent: "claude-code", Project: "Cammut", SessionID: "s1", Kind: "transcript", FP: strings.Repeat("a", 64), SrcSHA256: strings.Repeat("c", 64), Codec: "zstd", SrcStart: int64(i) * 100, SrcEnd: int64(i+1) * 100, PlainBytes: 300}
		body := ageLike(fmt.Sprintf("payload-%d", i))
		id := archive.SegmentID(m)
		if _, err := a.Put(context.Background(), id, m, sha(body), bytes.NewReader(body), 4<<20, 1); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return db, dir, ids
}

func arch(t *testing.T, db, dir string, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(append(append([]string{"archive"}, args...), "-db", db, "-archive-dir", dir), &out)
	return out.String(), err
}

func TestSnapshotIsConsistentWhileTheGatewayKeepsWriting(t *testing.T) {
	base := t.TempDir()
	db := filepath.Join(base, "live.db")
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for i := 0; i < 20; i++ {
		if _, _, err := st.CreateToken(fmt.Sprintf("before-%d", i), []string{"a/*"}); err != nil {
			t.Fatal(err)
		}
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { // a WAL writer that never pauses while the snapshot runs
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
				_ = st.AddAudit(store.Audit{TS: time.Now(), Upstream: "x", Tool: "t", OK: true, Note: fmt.Sprintf("n%d", i)})
			}
		}
	}()
	out := filepath.Join(base, "snap", "cammut-1.db")
	var buf bytes.Buffer
	err = run([]string{"admin", "db-snapshot", "-db", db, "-out", out}, &buf)
	close(stop)
	wg.Wait()
	if err != nil {
		t.Fatalf("snapshot: %v %s", err, buf.String())
	}
	snap, err := store.Open(out)
	if err != nil {
		t.Fatal(err)
	}
	defer snap.Close()
	var res string
	if err := snap.DB().QueryRow(`PRAGMA integrity_check`).Scan(&res); err != nil || res != "ok" {
		t.Fatalf("integrity_check: %q %v", res, err)
	}
	toks, err := snap.ListTokens()
	if err != nil || len(toks) != 20 {
		t.Fatalf("rows written before the call must be in the snapshot: %d %v", len(toks), err)
	}
	if runtime.GOOS != "windows" {
		if fi, err := os.Stat(out); err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("mode: %v %v", fi, err)
		}
	}
	if err := run([]string{"admin", "db-snapshot", "-db", db, "-out", out}, &buf); err == nil {
		t.Fatal("an existing output path must be refused")
	}
	if err := run([]string{"admin", "db-snapshot", "-db", db}, &buf); err == nil {
		t.Fatal("-out is required")
	}
}

func TestSnapshotKeepsOnlyTheNewestFiles(t *testing.T) {
	base := t.TempDir()
	db := filepath.Join(base, "live.db")
	if st, err := store.Open(db); err != nil {
		t.Fatal(err)
	} else {
		st.Close()
	}
	snaps := filepath.Join(base, "snapshots")
	var buf bytes.Buffer
	for i := 1; i <= 5; i++ {
		if err := run([]string{"admin", "db-snapshot", "-db", db, "-out", filepath.Join(snaps, fmt.Sprintf("cammut-2026101%dT000000Z.db", i)), "-keep", "3"}, &buf); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(snaps, "notes.txt"), []byte("not a snapshot"), 0o600)
	entries, _ := os.ReadDir(snaps)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	want := "cammut-20261013T000000Z.db cammut-20261014T000000Z.db cammut-20261015T000000Z.db notes.txt"
	if strings.Join(names, " ") != want {
		t.Fatalf("kept %v, want %s", names, want)
	}
}

func TestArchiveVerifyFindsAFlippedByteAndStatsNeverPrintsAnID(t *testing.T) {
	db, dir, ids := seeded(t)
	out, err := arch(t, db, dir, "verify")
	if err != nil || !strings.Contains(out, "ok 2 / missing 0 / corrupt 0") {
		t.Fatalf("clean archive: %q %v", out, err)
	}
	p := filepath.Join(dir, ids[0][:2], ids[0]+".age")
	b, _ := os.ReadFile(p)
	b[len(b)-1] ^= 0xff
	os.WriteFile(p, b, 0o600)
	out, err = arch(t, db, dir, "verify")
	if err == nil || !strings.Contains(out, "corrupt 1") || !strings.Contains(out, "ok 1") {
		t.Fatalf("a flipped byte must be reported and fail the command: %q %v", out, err)
	}
	os.Remove(filepath.Join(dir, ids[1][:2], ids[1]+".age"))
	out, err = arch(t, db, dir, "verify", "-sample", "5")
	if err == nil || !strings.Contains(out, "missing 1") {
		t.Fatalf("missing file: %q %v", out, err)
	}
	if out, err = arch(t, db, dir, "verify", "-project", "Nobody"); err != nil || !strings.Contains(out, "ok 0 / missing 0 / corrupt 0") {
		t.Fatalf("project filter: %q %v", out, err)
	}
	out, err = arch(t, db, dir, "stats")
	if err != nil || !strings.Contains(out, "Cammut") || !strings.Contains(out, "segments") {
		t.Fatalf("stats: %q %v", out, err)
	}
	for _, id := range ids {
		if strings.Contains(out, id) || strings.Contains(out, id[:8]) {
			t.Fatalf("stats must never print a segment id: %q", out)
		}
	}
}

func TestArchiveListAndReplicaRecordAndPins(t *testing.T) {
	db, dir, ids := seeded(t)
	out, err := arch(t, db, dir, "list", "-project", "Cammut", "-limit", "10")
	if err != nil || !strings.Contains(out, ids[0]) || !strings.Contains(out, ids[1]) {
		t.Fatalf("list: %q %v", out, err)
	}
	body := ageLike("payload-0")
	manifest := fmt.Sprintf(`{"items":[{"id":%q,"sha256":%q},{"id":%q,"sha256":%q}]}`, ids[0], sha(body), strings.Repeat("9", 32), sha(body))
	old := archiveStdin
	t.Cleanup(func() { archiveStdin = old })
	archiveStdin = strings.NewReader(manifest)
	out, err = arch(t, db, dir, "replica-record", "-remote", "mega")
	if err == nil || !strings.Contains(out, "verified 1 rejected 1") {
		t.Fatalf("a rejected item makes the command fail and is counted: %q %v", out, err)
	}
	archiveStdin = strings.NewReader(fmt.Sprintf(`{"items":[{"id":%q,"sha256":%q}]}`, ids[0], sha(body)))
	if out, err = arch(t, db, dir, "replica-record", "-remote", "mega"); err != nil || !strings.Contains(out, "verified 1 rejected 0") {
		t.Fatalf("replica-record: %q %v", out, err)
	}
	archiveStdin = strings.NewReader(`not json`)
	if _, err = arch(t, db, dir, "replica-record", "-remote", "mega"); err == nil {
		t.Fatal("bad manifest must fail")
	}
	if _, err = arch(t, db, dir, "replica-record"); err == nil {
		t.Fatal("-remote is required")
	}

	// a pin that changed is listed and re-pinned only by an explicit ack
	st, _ := store.Open(db)
	a, _ := archive.New(st.DB(), dir, 1<<30, 0, nil)
	put := func(start int64, rec string) {
		m := archive.Meta{Agent: "claude-code", Project: "Pinned", SessionID: "s2", Kind: "transcript", FP: strings.Repeat("a", 64), SrcSHA256: strings.Repeat("c", 64), Codec: "zstd", SrcStart: start, SrcEnd: start + 10, PlainBytes: 30, Recipients: rec}
		b := ageLike(rec)
		if _, err := a.Put(context.Background(), archive.SegmentID(m), m, sha(b), bytes.NewReader(b), 4<<20, 1); err != nil {
			t.Fatal(err)
		}
	}
	put(0, "aaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbb")
	put(10, "aaaaaaaaaaaaaaaa,cccccccccccccccc")
	st.Close()
	out, err = arch(t, db, dir, "pins")
	if err != nil || !strings.Contains(out, "Pinned") || !strings.Contains(out, "CHANGED") {
		t.Fatalf("pins: %q %v", out, err)
	}
	if _, err = arch(t, db, dir, "pins", "ack"); err == nil {
		t.Fatal("ack needs -project")
	}
	if out, err = arch(t, db, dir, "pins", "ack", "-project", "Pinned"); err != nil || !strings.Contains(out, "re-pinned") {
		t.Fatalf("ack: %q %v", out, err)
	}
	if out, _ = arch(t, db, dir, "pins"); strings.Contains(out, "CHANGED") {
		t.Fatalf("after ack: %q", out)
	}
}
