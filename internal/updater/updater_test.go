package updater

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCompareSemver(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"1.2.3", "1.2.3", 0},
		{"1.2.4", "1.2.3", 1},
		{"1.2.3", "1.2.4", -1},
		{"1.3.0", "1.2.9", 1},
		{"2.0.0", "1.9.9", 1},
		{"v1.2.3", "1.2.3", 0},
		{"1.2.3", "v1.2.3", 0},
		// prerelease precedence: release > prerelease of same core
		{"1.2.3", "1.2.3-beta.1", 1},
		{"1.2.3-beta.1", "1.2.3", -1},
		{"0.0.1-beta.25", "0.0.1-beta.24", 1},
		{"0.0.1-beta.24", "0.0.1-beta.25", -1},
		{"0.0.1-beta.24", "0.0.1-beta.24", 0},
		// numeric identifiers compare as ints, not strings
		{"1.0.0-beta.10", "1.0.0-beta.9", 1},
		// build metadata ignored
		{"1.2.3+abc", "1.2.3+def", 0},
		// fewer prerelease fields < more
		{"1.0.0-beta", "1.0.0-beta.1", -1},
	}
	for _, tt := range tests {
		if got := compareSemver(tt.a, tt.b); got != tt.want {
			t.Errorf("compareSemver(%q,%q)=%d want %d", tt.a, tt.b, got, tt.want)
		}
	}
}

func TestIsDevDetectsLocalBuilds(t *testing.T) {
	dev := []string{
		"dev",
		"",
		"v0.0.1-beta.24-3-gd7e8bf2-dirty",
		"v0.0.1-beta.24-3-gd7e8bf2",
		"0.0.1-beta.24-dirty",
	}
	for _, v := range dev {
		if !New(v).isDev() {
			t.Errorf("isDev(%q)=false, want true", v)
		}
	}
	release := []string{
		"v0.0.1-beta.24",
		"0.0.1-beta.24",
		"1.2.3",
		"v1.2.3",
	}
	for _, v := range release {
		if New(v).isDev() {
			t.Errorf("isDev(%q)=true, want false", v)
		}
	}
}

func TestInfoDevNoUpdate(t *testing.T) {
	// Any network access is a bug: dev builds short-circuit.
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("dev build must never hit the network; got %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer gh.Close()

	c := New("dev")
	c.githubAPI = gh.URL
	info, err := c.Check(context.Background())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if info.HasUpdate {
		t.Errorf("dev build should never report an update")
	}
	if info.Current != "dev" {
		t.Errorf("Current=%q want dev", info.Current)
	}
	if info.CheckedAt == "" {
		t.Errorf("CheckedAt should be stamped even for dev")
	}
}

// releaseJSON builds a GitHub releases/latest response body with the given tag
// and assets. browser_download_url values are resolved against server.URL so
// the install path can download from the same httptest server.
func releaseJSON(tag, body, htmlURL string, assets ...string) string {
	assetsJSON := "["
	for i, a := range assets {
		if i > 0 {
			assetsJSON += ","
		}
		assetsJSON += fmt.Sprintf(`{"name":%q,"browser_download_url":%q}`, a, "https://download.example/"+tag+"/"+a)
	}
	assetsJSON += "]"
	return fmt.Sprintf(`{"tag_name":%q,"html_url":%q,"body":%q,"assets":%s}`, tag, htmlURL, body, assetsJSON)
}

func releaseServer(t *testing.T, body string, status int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/releases/latest" {
			t.Errorf("unexpected request path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if got := r.Header.Get("Accept"); got != "application/vnd.github+json" {
			t.Errorf("Accept header = %q, want application/vnd.github+json", got)
		}
		w.WriteHeader(status)
		w.Write([]byte(body))
	}))
}

func TestCheckHasUpdate(t *testing.T) {
	gh := releaseServer(t, releaseJSON(
		"v0.0.1-beta.25",
		"## v0.0.1-beta.25\n- fix things",
		"https://github.com/Yeshwanthyk/pican/releases/tag/v0.0.1-beta.25",
		"pican-darwin-arm64", "pican-darwin-amd64", "pican-linux-amd64", "pican-linux-arm64",
	), http.StatusOK)
	defer gh.Close()

	c := New("v0.0.1-beta.24")
	c.githubAPI = gh.URL

	info, err := c.Check(context.Background())
	if err != nil {
		t.Fatalf("Check err: %v", err)
	}
	if !info.HasUpdate {
		t.Fatalf("expected HasUpdate true, got %+v", info)
	}
	if info.Latest != "v0.0.1-beta.25" {
		t.Errorf("Latest=%q want v0.0.1-beta.25", info.Latest)
	}
	// Changelog comes from the release body, ChangelogURL from html_url.
	if info.Changelog != "## v0.0.1-beta.25\n- fix things" {
		t.Errorf("Changelog=%q want release body", info.Changelog)
	}
	if info.ChangelogURL != "https://github.com/Yeshwanthyk/pican/releases/tag/v0.0.1-beta.25" {
		t.Errorf("ChangelogURL=%q want release html_url", info.ChangelogURL)
	}
	// Cached Info() should match.
	if c.Info().Latest != info.Latest {
		t.Errorf("cached Info() not updated")
	}
}

func TestCheckUpToDate(t *testing.T) {
	gh := releaseServer(t, releaseJSON("v0.0.1-beta.24", "", ""), http.StatusOK)
	defer gh.Close()

	c := New("v0.0.1-beta.24")
	c.githubAPI = gh.URL

	info, err := c.Check(context.Background())
	if err != nil {
		t.Fatalf("Check err: %v", err)
	}
	if info.HasUpdate {
		t.Errorf("expected no update, got %+v", info)
	}
	if info.Latest != "v0.0.1-beta.24" {
		t.Errorf("Latest=%q want v0.0.1-beta.24", info.Latest)
	}
}

func TestCheckNoPublishedRelease(t *testing.T) {
	gh := releaseServer(t, `{"message":"Not Found"}`, http.StatusNotFound)
	defer gh.Close()

	c := New("v0.0.1-beta.24")
	c.githubAPI = gh.URL

	_, err := c.Check(context.Background())
	if err == nil {
		t.Fatalf("expected error for missing release")
	}
	if !strings.Contains(err.Error(), "no published release") {
		t.Errorf("error should explain the 404, got: %v", err)
	}
}

func TestLatestAssetMatchesPlatform(t *testing.T) {
	gh := releaseServer(t, releaseJSON(
		"v0.0.1-beta.25",
		"body",
		"https://github.com/Yeshwanthyk/pican/releases/tag/v0.0.1-beta.25",
		"pican-darwin-arm64", "pican-darwin-amd64", "pican-windows-amd64.exe", "sha256sums.txt",
	), http.StatusOK)
	defer gh.Close()

	c := New("v0.0.1-beta.24")
	c.githubAPI = gh.URL

	tag, name, url, err := c.LatestAsset(context.Background(), "darwin-arm64")
	if err != nil {
		t.Fatalf("LatestAsset err: %v", err)
	}
	if tag != "v0.0.1-beta.25" {
		t.Errorf("tag=%q want v0.0.1-beta.25", tag)
	}
	if name != "pican-darwin-arm64" {
		t.Errorf("name=%q want pican-darwin-arm64", name)
	}
	if url != "https://download.example/v0.0.1-beta.25/pican-darwin-arm64" {
		t.Errorf("url=%q", url)
	}

	// Windows assets carry the .exe suffix (parity with install.ps1).
	if _, name, _, err := c.LatestAsset(context.Background(), "windows-amd64"); err != nil {
		t.Errorf("windows-amd64 should resolve: %v", err)
	} else if name != "pican-windows-amd64.exe" {
		t.Errorf("windows name=%q want pican-windows-amd64.exe", name)
	}

	// Missing platform is a clear error.
	_, _, _, err = c.LatestAsset(context.Background(), "freebsd-amd64")
	if err == nil {
		t.Fatalf("expected error for missing platform asset")
	}
	if !strings.Contains(err.Error(), "no asset") || !strings.Contains(err.Error(), "freebsd-amd64") {
		t.Errorf("error should name the missing platform, got: %v", err)
	}
}

func TestLatestChecksumsURL(t *testing.T) {
	gh := releaseServer(t, releaseJSON(
		"v0.0.1-beta.25",
		"",
		"",
		"pican-darwin-arm64", "sha256sums.txt",
	), http.StatusOK)
	defer gh.Close()

	c := New("v0.0.1-beta.24")
	c.githubAPI = gh.URL

	url, err := c.LatestChecksumsURL(context.Background())
	if err != nil {
		t.Fatalf("LatestChecksumsURL err: %v", err)
	}
	if url != "https://download.example/v0.0.1-beta.25/sha256sums.txt" {
		t.Errorf("url=%q", url)
	}
}

func TestLatestChecksumsAbsent(t *testing.T) {
	gh := releaseServer(t, releaseJSON("v0.0.1-beta.25", "", "", "pican-darwin-arm64"), http.StatusOK)
	defer gh.Close()

	c := New("v0.0.1-beta.24")
	c.githubAPI = gh.URL

	url, err := c.LatestChecksumsURL(context.Background())
	if err != nil {
		t.Fatalf("LatestChecksumsURL err: %v", err)
	}
	if url != "" {
		t.Errorf("url=%q want empty when no checksum asset", url)
	}
}

func TestLatestAssetReusesCachedRelease(t *testing.T) {
	gh := releaseServer(t, releaseJSON(
		"v0.0.1-beta.25",
		"body",
		"",
		"pican-darwin-arm64",
	), http.StatusOK)
	defer gh.Close()

	c := New("v0.0.1-beta.24")
	c.githubAPI = gh.URL

	// Check caches the release; LatestAsset must then resolve from cache
	// without touching the network (the API URL becomes a dead server).
	if _, err := c.Check(context.Background()); err != nil {
		t.Fatalf("Check err: %v", err)
	}
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("LatestAsset must reuse the cached release, not refetch; got %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer dead.Close()
	c.githubAPI = dead.URL

	tag, name, _, err := c.LatestAsset(context.Background(), "darwin-arm64")
	if err != nil {
		t.Fatalf("LatestAsset err: %v", err)
	}
	if tag != "v0.0.1-beta.25" || name != "pican-darwin-arm64" {
		t.Errorf("got (%q, %q), want (v0.0.1-beta.25, pican-darwin-arm64)", tag, name)
	}
}

func TestAssetNameForPlatform(t *testing.T) {
	tests := map[string]string{
		"darwin-amd64":  "pican-darwin-amd64",
		"darwin-arm64":  "pican-darwin-arm64",
		"linux-amd64":   "pican-linux-amd64",
		"linux-arm64":   "pican-linux-arm64",
		"windows-amd64": "pican-windows-amd64.exe",
		"windows-arm64": "pican-windows-arm64.exe",
	}
	for platform, want := range tests {
		if got := assetNameForPlatform(platform); got != want {
			t.Errorf("assetNameForPlatform(%q)=%q want %q", platform, got, want)
		}
	}
}
