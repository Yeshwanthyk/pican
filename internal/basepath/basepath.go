// Package basepath owns pican's optional HTTP mount prefix.
package basepath

import (
	"fmt"
	"net/http"
	"path"
	"strings"
)

// Path is a normalized URL path prefix. The root mount is represented by "".
type Path struct {
	value string
}

// Parse normalizes a mount prefix such as "/s/abc123".
func Parse(raw string) (Path, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "/" {
		return Path{}, nil
	}
	if !strings.HasPrefix(raw, "/") {
		return Path{}, fmt.Errorf("base path must start with /: %q", raw)
	}
	if strings.ContainsAny(raw, "?#") {
		return Path{}, fmt.Errorf("base path must not contain a query or fragment: %q", raw)
	}
	clean := path.Clean(raw)
	if clean == "." || clean == "/" {
		return Path{}, nil
	}
	if clean != raw && strings.TrimSuffix(raw, "/") != clean {
		return Path{}, fmt.Errorf("base path is not normalized: %q", raw)
	}
	return Path{value: clean}, nil
}

// MustParse is Parse for static configuration and tests.
func MustParse(raw string) Path {
	p, err := Parse(raw)
	if err != nil {
		panic(err)
	}
	return p
}

func (p Path) String() string { return p.value }

// URL prefixes a root-relative live URL with the mount path.
func (p Path) URL(route string) string {
	if route == "" {
		route = "/"
	}
	if !strings.HasPrefix(route, "/") {
		return route
	}
	if p.value == "" || route == p.value || strings.HasPrefix(route, p.value+"/") {
		return route
	}
	return p.value + route
}

// Handler mounts an inner root-based handler at this path and strips the
// prefix before dispatch. Requests outside the mount fail closed with 404.
func (p Path) Handler(inner http.Handler) http.Handler {
	if p.value == "" {
		return inner
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != p.value && !strings.HasPrefix(r.URL.Path, p.value+"/") {
			http.NotFound(w, r)
			return
		}
		clone := r.Clone(r.Context())
		clone.URL.Path = strings.TrimPrefix(r.URL.Path, p.value)
		if clone.URL.Path == "" {
			clone.URL.Path = "/"
		}
		clone.URL.RawPath = ""
		inner.ServeHTTP(w, clone)
	})
}
