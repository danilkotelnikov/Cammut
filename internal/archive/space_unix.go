//go:build !windows

package archive

import "golang.org/x/sys/unix"

func (s *Store) freeBytes() (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(s.dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}
