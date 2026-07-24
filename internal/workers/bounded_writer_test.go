package workers

import "testing"

func TestBoundedWriterRetainsTail(t *testing.T) {
	w := &BoundedWriter{Max: 8}
	for _, chunk := range []string{"abc", "defgh", "ijkl"} {
		if n, err := w.Write([]byte(chunk)); err != nil || n != len(chunk) {
			t.Fatalf("Write(%q) = %d, %v", chunk, n, err)
		}
	}
	if got := w.String(); got != "efghijkl" {
		t.Fatalf("String() = %q, want %q", got, "efghijkl")
	}

	if _, err := w.Write([]byte("0123456789")); err != nil {
		t.Fatal(err)
	}
	if got := w.String(); got != "23456789" {
		t.Fatalf("String() after oversized write = %q, want %q", got, "23456789")
	}
}
