package archive

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"cammut/internal/store"
)

func ageLike(payload string) []byte {
	return []byte("age-encryption.org/v1\n-> X25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n--- CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n" + payload)
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func newArchive(t *testing.T, max, minFree int64) (*Store, string) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	dir := filepath.Join(t.TempDir(), "archive")
	a, err := New(st.DB(), dir, max, minFree, func() time.Time { return time.Unix(1_800_000_000, 0) })
	if err != nil {
		t.Fatal(err)
	}
	return a, dir
}

func meta(start, end int64) Meta {
	return Meta{Agent: "claude-code", Project: "Cammut", SessionID: "s1", Kind: "transcript", FP: strings.Repeat("a", 64), SrcSHA256: strings.Repeat("c", 64), Codec: "zstd", SrcStart: start, SrcEnd: end, PlainBytes: 3 * (end - start)}
}

func TestPutIsIdempotentKeepsTheFirstCopyAndRefusesPlaintext(t *testing.T) {
	a, dir := newArchive(t, 1<<30, 0)
	ctx := context.Background()
	m := meta(0, 100)
	id := SegmentID(m)
	first := ageLike("first")
	r, err := a.Put(ctx, id, m, sum(first), bytes.NewReader(first), 4<<20, 7)
	if err != nil || !r.Created || r.SHA != sum(first) || !r.Matches {
		t.Fatalf("first put: %+v %v", r, err)
	}
	path := filepath.Join(dir, id[:2], id+".age")
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("file: %v %v", fi, err)
	}
	// a retry after a crash re-seals the same range: different bytes, same id → the first copy stays
	second := ageLike("second, a different ciphertext of the same range")
	r2, err := a.Put(ctx, id, m, sum(second), bytes.NewReader(second), 4<<20, 7)
	if err != nil || r2.Created || r2.Matches || r2.SHA != sum(first) {
		t.Fatalf("idempotent put must keep the first copy and report its sha: %+v %v", r2, err)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, first) {
		t.Fatal("the stored segment was overwritten")
	}
	for name, tc := range map[string]struct {
		id   string
		m    Meta
		body []byte
		sha  string
		want error
	}{
		"plaintext":      {SegmentID(meta(100, 200)), meta(100, 200), []byte("hello world, definitely not age"), sum([]byte("hello world, definitely not age")), ErrNotAge},
		"wrong sha":      {SegmentID(meta(100, 200)), meta(100, 200), ageLike("x"), strings.Repeat("0", 64), ErrBadInput},
		"id mismatch":    {strings.Repeat("0", 32), meta(100, 200), ageLike("x"), sum(ageLike("x")), ErrBadInput},
		"bad range":      {SegmentID(meta(200, 100)), meta(200, 100), ageLike("x"), sum(ageLike("x")), ErrBadInput},
		"relpath escape": {"", Meta{Agent: "claude-code", Project: "p", SessionID: "s", Kind: "sidecar", Relpath: "../../etc/passwd", FP: strings.Repeat("a", 64), Codec: "br", SrcEnd: 5}, ageLike("x"), sum(ageLike("x")), ErrBadInput},
	} {
		if tc.id == "" {
			tc.id = SegmentID(tc.m)
		}
		if _, err := a.Put(ctx, tc.id, tc.m, tc.sha, bytes.NewReader(tc.body), 4<<20, 7); !errors.Is(err, tc.want) {
			t.Fatalf("%s: want %v got %v", name, tc.want, err)
		}
	}
	big := ageLike(strings.Repeat("z", 5<<20))
	m3 := meta(300, 400)
	if _, err := a.Put(ctx, SegmentID(m3), m3, sum(big), bytes.NewReader(big), 4<<20, 7); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("over the limit: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, id[:2]))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("temporary file left behind: %s", e.Name())
		}
	}
}

func TestQuotaStopsTheArchiveBeforeItFillsTheDisk(t *testing.T) {
	a, _ := newArchive(t, 400, 0)
	m := meta(0, 10)
	body := ageLike(strings.Repeat("q", 300))
	if _, err := a.Put(context.Background(), SegmentID(m), m, sum(body), bytes.NewReader(body), 4<<20, 1); !errors.Is(err, ErrQuota) {
		t.Fatalf("a segment that would exceed the quota: %v", err)
	}
}

func TestCoverageMergesRangesPerGenerationAndNeverClaimsMore(t *testing.T) {
	a, _ := newArchive(t, 1<<30, 0)
	ctx := context.Background()
	put := func(m Meta) {
		b := ageLike(m.FP[:4] + string(rune('a'+m.SrcStart%26)))
		if _, err := a.Put(ctx, SegmentID(m), m, sum(b), bytes.NewReader(b), 4<<20, 1); err != nil {
			t.Fatal(err)
		}
	}
	put(meta(0, 100))
	put(meta(100, 250))
	put(meta(400, 500)) // a gap: 250..400 is missing
	c, err := a.Coverage("claude-code", "s1")
	if err != nil || c.ContiguousTo != 250 || len(c.Ranges) != 2 || c.Ranges[0] != [2]int64{0, 250} || c.Ranges[1] != [2]int64{400, 500} {
		t.Fatalf("gap: %+v %v", c, err)
	}
	put(meta(250, 400)) // the gap is filled, with an overlap at the edges
	put(meta(90, 120))
	c, _ = a.Coverage("claude-code", "s1")
	if c.ContiguousTo != 500 || len(c.Ranges) != 1 {
		t.Fatalf("filled: %+v", c)
	}
	// the file was rewritten: a new fingerprint starts a new generation and the old coverage no longer counts
	n := meta(0, 60)
	n.FP = strings.Repeat("b", 64)
	put(n)
	c, _ = a.Coverage("claude-code", "s1")
	if c.FP != n.FP || c.ContiguousTo != 60 {
		t.Fatalf("a new generation must not inherit the old coverage: %+v", c)
	}
	if c, _ := a.Coverage("claude-code", "nobody"); c.ContiguousTo != 0 || len(c.Ranges) != 0 {
		t.Fatalf("unknown session: %+v", c)
	}
}

func TestSameIDWithDifferentPlaintextHashIsRejectedAndReplicasNeedTheStoredSha(t *testing.T) {
	a, _ := newArchive(t, 1<<30, 0)
	ctx := context.Background()
	m := meta(0, 100)
	id := SegmentID(m)
	b1 := ageLike("one")
	if _, err := a.Put(ctx, id, m, sum(b1), bytes.NewReader(b1), 4<<20, 1); err != nil {
		t.Fatal(err)
	}
	changed := m
	changed.SrcSHA256 = strings.Repeat("d", 64) // the file was rewritten with the same length: same id, different plaintext
	b2 := ageLike("two")
	if _, err := a.Put(ctx, id, changed, sum(b2), bytes.NewReader(b2), 4<<20, 1); !errors.Is(err, ErrContentMismatch) {
		t.Fatalf("first-copy-wins must not launder different content under an old id: %v", err)
	}
	c, _ := a.Coverage("claude-code", "s1")
	if len(c.Segs) != 1 || c.Segs[0].SrcSHA256 != m.SrcSHA256 || c.Segs[0].Replicated {
		t.Fatalf("coverage reports the acknowledged plaintext hash and no replica yet: %+v", c.Segs)
	}
	res, err := a.RecordReplica("mega", []ReplicaItem{{ID: id, SHA256: strings.Repeat("0", 64)}, {ID: strings.Repeat("9", 32), SHA256: sum(b1)}})
	if err != nil || res.Verified != 0 || res.Rejected != 2 {
		t.Fatalf("a replica with the wrong sha or an unknown id is rejected: %+v %v", res, err)
	}
	if res, _ := a.RecordReplica("mega", []ReplicaItem{{ID: id, SHA256: sum(b1)}}); res.Verified != 1 {
		t.Fatalf("%+v", res)
	}
	c, _ = a.Coverage("claude-code", "s1")
	if !c.Segs[0].Replicated {
		t.Fatal("replicated after a verified record")
	}
	newest := meta(100, 200)
	b3 := ageLike("three")
	a.Put(ctx, SegmentID(newest), newest, sum(b3), bytes.NewReader(b3), 4<<20, 1)
	c, _ = a.Coverage("claude-code", "s1")
	if c.Segs[1].Replicated || ReplicatedThrough(c) != 100 {
		t.Fatalf("a replica run that predates the newest segment protects only what it covered: %+v", c.Segs)
	}
}

func TestRecipientPinFlagsAChangeButStillStores(t *testing.T) {
	a, _ := newArchive(t, 1<<30, 0)
	ctx := context.Background()
	m1 := meta(0, 10)
	m1.Recipients = "aaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbb"
	b := ageLike("x")
	if r, err := a.Put(ctx, SegmentID(m1), m1, sum(b), bytes.NewReader(b), 4<<20, 1); err != nil || r.RecipientsChanged {
		t.Fatalf("first sight pins: %+v %v", r, err)
	}
	m2 := meta(10, 20)
	m2.Recipients = "aaaaaaaaaaaaaaaa,cccccccccccccccc" // the recovery recipient was swapped
	b2 := ageLike("y")
	r, err := a.Put(ctx, SegmentID(m2), m2, sum(b2), bytes.NewReader(b2), 4<<20, 1)
	if err != nil || !r.RecipientsChanged || !r.Created {
		t.Fatalf("a changed recipient set is flagged and the segment is stored: %+v %v", r, err)
	}
	pins, _ := a.RecipientPins()
	if len(pins) != 1 || !pins[0].Changed {
		t.Fatalf("%+v", pins)
	}
}

func TestReconcileRemovesTempFilesAndReportsMissingSegments(t *testing.T) {
	a, dir := newArchive(t, 1<<30, 0)
	m := meta(0, 10)
	b := ageLike("x")
	a.Put(context.Background(), SegmentID(m), m, sum(b), bytes.NewReader(b), 4<<20, 1)
	os.MkdirAll(filepath.Join(dir, "zz"), 0o700)
	os.WriteFile(filepath.Join(dir, "zz", "leftover.age.tmp"), []byte("partial"), 0o600)
	os.Remove(filepath.Join(dir, SegmentID(m)[:2], SegmentID(m)+".age"))
	rep, err := a.Reconcile()
	if err != nil || rep.TempRemoved != 1 || len(rep.Missing) != 1 || rep.Missing[0] != SegmentID(m) {
		t.Fatalf("%+v %v", rep, err)
	}
}

// F3: a complete offsite check replaces what the remote is claimed to hold. Yesterday A and B were replicated; today B
// is corrupt on the remote, the check verifies only A, and recording that must retire the claim for B.
func TestReplicaRecordReplacesTheRemotesVerifiedSet(t *testing.T) {
	a, _ := newArchive(t, 1<<30, 0)
	ctx := context.Background()
	var ids [2]string
	var shas [2]string
	for i := range ids {
		m := meta(int64(i)*100, int64(i)*100+100)
		b := ageLike("seg" + string(rune('A'+i)))
		ids[i], shas[i] = SegmentID(m), sum(b)
		if _, err := a.Put(ctx, ids[i], m, shas[i], bytes.NewReader(b), 4<<20, 1); err != nil {
			t.Fatal(err)
		}
	}
	both := []ReplicaItem{{ID: ids[0], SHA256: shas[0]}, {ID: ids[1], SHA256: shas[1]}}
	if res, err := a.RecordReplica("mega", both); err != nil || res.Verified != 2 {
		t.Fatalf("%+v %v", res, err)
	}
	// another remote keeps its own claims
	if _, err := a.RecordReplica("b2", both[:1]); err != nil {
		t.Fatal(err)
	}
	// today: only A passed on "mega"
	if res, err := a.RecordReplica("mega", both[:1]); err != nil || res.Verified != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	c, _ := a.Coverage("claude-code", "s1")
	if !c.Segs[0].Replicated || c.Segs[1].Replicated {
		t.Fatalf("B failed today's check on its only remote, so it must not stay replicated: %+v", c.Segs)
	}
	if rs, _ := a.ReplicaStatus(); rs.Replicated != 1 || rs.Unreplicated != 1 {
		t.Fatalf("status must agree with coverage: %+v", rs)
	}
	// an empty complete check retires everything of that remote and nothing of the other
	if _, err := a.RecordReplica("mega", nil); err != nil {
		t.Fatal(err)
	}
	c, _ = a.Coverage("claude-code", "s1")
	if !c.Segs[0].Replicated {
		t.Fatal("the other remote still holds A")
	}
	if _, err := a.RecordReplica("b2", nil); err != nil {
		t.Fatal(err)
	}
	c, _ = a.Coverage("claude-code", "s1")
	if c.Segs[0].Replicated || c.Segs[1].Replicated {
		t.Fatalf("no remote verified anything: %+v", c.Segs)
	}
}

// F9: temporary uploads count against the quota while they stream. With the archive full, concurrent PUTs must not each
// park megabytes in temp files first.
func TestUploadsReserveQuotaWhileStreaming(t *testing.T) {
	const quota = 512 << 10
	a, dir := newArchive(t, quota, 0)
	tmpBytes := func() (n int64) {
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() && strings.HasSuffix(p, ".tmp") {
				if fi, e := d.Info(); e == nil {
					n += fi.Size()
				}
			}
			return nil
		})
		return n
	}
	var peak int64
	var mu sync.Mutex
	watch := func() {
		n := tmpBytes()
		mu.Lock()
		if n > peak {
			peak = n
		}
		mu.Unlock()
	}
	// a body that looks like age and keeps going for 3 MiB, sampling the temp directory as it is read
	body := func() io.Reader {
		head := bytes.NewReader([]byte(ageMagic))
		var sent int
		rest := readerFunc(func(p []byte) (int, error) {
			if sent >= 3<<20 {
				return 0, io.EOF
			}
			watch()
			n := len(p)
			if n > 32<<10 {
				n = 32 << 10
			}
			for i := 0; i < n; i++ {
				p[i] = 'z'
			}
			sent += n
			return n, nil
		})
		return io.MultiReader(head, rest)
	}
	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			m := meta(int64(i)*100, int64(i)*100+100)
			_, errs[i] = a.Put(context.Background(), SegmentID(m), m, strings.Repeat("0", 64), body(), 4<<20, 1)
		}(i)
	}
	wg.Wait()
	watch()
	if peak > quota {
		t.Fatalf("temporary uploads held %d bytes at once with a quota of %d", peak, quota)
	}
	for i, err := range errs {
		if err == nil {
			t.Fatalf("upload %d cannot have succeeded", i)
		}
	}
	if tmpBytes() != 0 {
		t.Fatal("temporary files left behind")
	}
	// nothing stays reserved: a real segment fits afterwards
	m := meta(900, 1000)
	b := ageLike("fits")
	if _, err := a.Put(context.Background(), SegmentID(m), m, sum(b), bytes.NewReader(b), 4<<20, 1); err != nil {
		t.Fatalf("the reservations of failed uploads were not released: %v", err)
	}
}

type readerFunc func(p []byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }

// F9: only MaxWriters uploads stream at once; the next is refused at once with ErrBusy and costs nothing.
func TestConcurrentUploadsAreCapped(t *testing.T) {
	a, dir := newArchive(t, 1<<30, 0)
	gate := make(chan struct{})
	started := make(chan struct{}, MaxWriters)
	var wg sync.WaitGroup
	for i := 0; i < MaxWriters; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			m := meta(int64(i)*100, int64(i)*100+100)
			b := ageLike("slow")
			r := io.MultiReader(bytes.NewReader(b[:30]), readerFunc(func(p []byte) (int, error) {
				started <- struct{}{}
				<-gate
				return 0, io.EOF
			}))
			a.Put(context.Background(), SegmentID(m), m, sum(b), r, 4<<20, 1)
		}(i)
	}
	for i := 0; i < MaxWriters; i++ {
		<-started
	}
	m := meta(900, 1000)
	b := ageLike("one too many")
	if _, err := a.Put(context.Background(), SegmentID(m), m, sum(b), bytes.NewReader(b), 4<<20, 1); !errors.Is(err, ErrBusy) {
		t.Fatalf("the %dth concurrent upload: %v", MaxWriters+1, err)
	}
	close(gate)
	wg.Wait()
	if _, err := a.Put(context.Background(), SegmentID(m), m, sum(b), bytes.NewReader(b), 4<<20, 1); err != nil {
		t.Fatalf("a slot is free again: %v", err)
	}
	if es, _ := os.ReadDir(filepath.Join(dir, SegmentID(m)[:2])); len(es) != 1 {
		t.Fatalf("only the stored segment may remain: %v", es)
	}
}

func TestUnreadableFreeSpaceRefusesInsteadOfAdmitting(t *testing.T) {
	a, _ := newArchive(t, 0, 1<<20)
	a.freeFn = func() (int64, error) { return 0, errors.New("volume cannot be measured") }
	m := meta(0, 10)
	body := ageLike("p")
	if _, err := a.Put(context.Background(), SegmentID(m), m, sum(body), bytes.NewReader(body), 4<<20, 1); !errors.Is(err, ErrQuota) {
		t.Fatalf("a minimum-free reserve that cannot be checked must refuse the upload: %v", err)
	}
	a.freeFn = nil // sanity: the real volume admits the same upload
	a.minFree = 1
	if _, err := a.Put(context.Background(), SegmentID(m), m, sum(body), bytes.NewReader(body), 4<<20, 1); err != nil {
		t.Fatalf("a measurable volume must admit it: %v", err)
	}
}
