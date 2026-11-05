package archive

import (
	"path/filepath"
	"testing"
)

func TestFreeBytesUsesArchiveVolume(t *testing.T) {
	s := &Store{dir: t.TempDir()}
	free, err := s.freeBytes()
	if err != nil || free <= 0 {
		t.Fatalf("free space: %d, %v", free, err)
	}
	s.dir = filepath.Join(s.dir, "not-created")
	if _, err := s.freeBytes(); err == nil {
		t.Fatal("missing archive directory must return an error")
	}
}
