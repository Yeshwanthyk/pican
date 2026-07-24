package workers

import "sync"

// BoundedWriter retains only the most recent Max bytes written to it.
type BoundedWriter struct {
	Max int

	mu    sync.Mutex
	buf   []byte
	start int
	size  int
}

func (w *BoundedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	written := len(p)
	if w.Max <= 0 || written == 0 {
		return written, nil
	}
	if len(w.buf) != w.Max {
		w.buf = make([]byte, w.Max)
		w.start = 0
		w.size = 0
	}
	if len(p) >= w.Max {
		copy(w.buf, p[len(p)-w.Max:])
		w.start = 0
		w.size = w.Max
		return written, nil
	}

	for len(p) > 0 {
		if w.size < w.Max {
			end := (w.start + w.size) % w.Max
			n := min(len(p), w.Max-w.size, w.Max-end)
			copy(w.buf[end:end+n], p[:n])
			w.size += n
			p = p[n:]
			continue
		}
		n := min(len(p), w.Max-w.start)
		copy(w.buf[w.start:w.start+n], p[:n])
		w.start = (w.start + n) % w.Max
		p = p[n:]
	}
	return written, nil
}

func (w *BoundedWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.size == 0 {
		return ""
	}
	if w.start+w.size <= len(w.buf) {
		return string(w.buf[w.start : w.start+w.size])
	}
	out := make([]byte, w.size)
	n := copy(out, w.buf[w.start:])
	copy(out[n:], w.buf[:w.size-n])
	return string(out)
}
