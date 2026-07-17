//go:build !windows

package app

import (
	"fmt"
	"os"
	"syscall"
)

// lockStateFile takes an exclusive non-blocking flock on f. The caller must
// keep f open for the lock to remain held; closing f releases the lock.
func lockStateFile(f *os.File) error {
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if err == syscall.EWOULDBLOCK {
			return fmt.Errorf("another pi-web instance appears to be running (state file at %s is locked); exit it first, or remove the file if stale", f.Name())
		}
		return err
	}
	return nil
}
