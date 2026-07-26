package basepath

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseAndURL(t *testing.T) {
	p, err := Parse("/s/test/")
	if err != nil {
		t.Fatal(err)
	}
	if got := p.String(); got != "/s/test" {
		t.Fatalf("String() = %q", got)
	}
	if got := p.URL("/api/session?id=1"); got != "/s/test/api/session?id=1" {
		t.Fatalf("URL() = %q", got)
	}
	if got := p.URL("/s/test/settings"); got != "/s/test/settings" {
		t.Fatalf("already-prefixed URL() = %q", got)
	}
}

func TestParseRejectsInvalidPaths(t *testing.T) {
	for _, input := range []string{"s/test", "/s/../test", "/s/test?q=1", "/s/test#x"} {
		if _, err := Parse(input); err == nil {
			t.Errorf("Parse(%q) unexpectedly succeeded", input)
		}
	}
}

func TestHandlerStripsOnlyConfiguredMount(t *testing.T) {
	var gotPath string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	})
	h := MustParse("/s/test").Handler(inner)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/s/test/api/session?id=1", nil))
	if rec.Code != http.StatusNoContent || gotPath != "/api/session" {
		t.Fatalf("status/path = %d %q", rec.Code, gotPath)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/session", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("outside mount status = %d", rec.Code)
	}
}
