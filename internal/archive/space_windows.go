package archive

import (
	"math"

	"golang.org/x/sys/windows"
)

func (s *Store) freeBytes() (int64, error) {
	dir, err := windows.UTF16PtrFromString(s.dir)
	if err != nil {
		return 0, err
	}
	var available uint64
	if err := windows.GetDiskFreeSpaceEx(dir, &available, nil, nil); err != nil {
		return 0, err
	}
	if available > math.MaxInt64 {
		return math.MaxInt64, nil
	}
	return int64(available), nil
}
