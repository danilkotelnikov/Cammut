package memory

import (
	"crypto/rand"
	"time"
)

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// newULID returns a 26-character ULID: 48 bits of millisecond time, 80 random bits, Crockford base32.
func newULID(t time.Time) string {
	var b [16]byte
	ms := uint64(t.UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (8 * (5 - i)))
	}
	if _, err := rand.Read(b[6:]); err != nil {
		panic("memory: crypto/rand failed: " + err.Error())
	}
	var out [26]byte
	// 128 bits as 26 groups of 5 bits, most significant first (the first group carries only 3 bits).
	for i := 0; i < 26; i++ {
		shift := 125 - 5*i
		var v byte
		for bit := 0; bit < 5; bit++ {
			pos := shift + bit // bit index from the least significant end
			if pos > 127 {
				continue
			}
			byteIdx := 15 - pos/8
			if b[byteIdx]>>(uint(pos)%8)&1 == 1 {
				v |= 1 << uint(bit)
			}
		}
		out[i] = crockford[v]
	}
	return string(out[:])
}
