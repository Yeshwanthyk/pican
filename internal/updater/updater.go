// Package updater checks whether a newer pican release is available. It
// compares the build-time version against the latest GitHub Release (the
// install channel) and exposes that release's assets so the in-app updater
// can download the matching platform binary. Results are cached in memory and
// refreshed by a background poll; callers can also force an immediate check.
package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// defaultGitHubAPI is the GitHub REST API base for the pican repository.
	// The in-app updater resolves releases and assets through it; binary and
	// checksum downloads use the asset URLs it returns.
	defaultGitHubAPI = "https://api.github.com/repos/Yeshwanthyk/pican"
	// PollInterval is how often the background goroutine refreshes the cache.
	PollInterval = 6 * time.Hour
	httpTimeout  = 10 * time.Second
)

// Info is the snapshot returned to the API layer (and marshalled to JSON).
type Info struct {
	Current      string `json:"current"`
	Latest       string `json:"latest"`
	HasUpdate    bool   `json:"hasUpdate"`
	IsDev        bool   `json:"isDev"`
	Changelog    string `json:"changelog"`
	ChangelogURL string `json:"changelogUrl"`
	CheckedAt    string `json:"checkedAt"`
}

// Asset is a downloadable file attached to a GitHub release.
type Asset struct {
	Name        string
	DownloadURL string
}

// Release is a published GitHub release as the updater consumes it: the tag
// (semver, usually "v"-prefixed), the release page URL, the markdown body
// used as the changelog, and the attached assets.
type Release struct {
	Tag     string
	HTMLURL string
	Body    string
	Assets  []Asset
}

// devVersionRe matches `git describe` development builds: a tag followed by a
// commits-ahead count and an abbreviated SHA (e.g. "-3-gd7e8bf2"), optionally
// "-dirty". Clean release builds are exactly the tag and don't match.
var devVersionRe = regexp.MustCompile(`-\d+-g[0-9a-f]{7,}|-dirty$`)

// Checker holds the current version and the cached result of the last remote
// check. It is safe for concurrent use.
type Checker struct {
	current   string
	githubAPI string
	client    *http.Client

	mu           sync.RWMutex
	release      *Release // cached latest release (nil until first successful check)
	latest       string
	changelog    string
	changelogURL string
	checkedAt    time.Time
}

// New builds a Checker for the given build-time version. version "dev" (or
// empty) disables remote checks — Info always reports no update available.
func New(version string) *Checker {
	if version == "" {
		version = "dev"
	}
	return &Checker{
		current:   version,
		githubAPI: defaultGitHubAPI,
		client:    &http.Client{Timeout: httpTimeout},
	}
}

// isDev reports whether the current build is a local/dev build that should
// never be compared against published releases. This covers the literal "dev"
// sentinel as well as `git describe` builds that are ahead of a tag or dirty —
// updating those would silently downgrade local work to the published release.
func (c *Checker) isDev() bool {
	return c.current == "" || c.current == "dev" || devVersionRe.MatchString(c.current)
}

// Info returns the current cached snapshot without making network calls.
func (c *Checker) Info() Info {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshotLocked()
}

func (c *Checker) snapshotLocked() Info {
	info := Info{
		Current:      c.current,
		Latest:       c.latest,
		IsDev:        c.isDev(),
		Changelog:    c.changelog,
		ChangelogURL: c.changelogURL,
	}
	if !c.checkedAt.IsZero() {
		info.CheckedAt = c.checkedAt.UTC().Format(time.RFC3339)
	}
	if !c.isDev() && c.latest != "" {
		info.HasUpdate = compareSemver(c.latest, c.current) > 0
	}
	return info
}

// Check performs a fresh remote fetch and updates the cache. It returns the
// resulting snapshot. For dev builds it short-circuits and only stamps
// checkedAt so the UI can show "checked just now".
func (c *Checker) Check(ctx context.Context) (Info, error) {
	if c.isDev() {
		c.mu.Lock()
		c.checkedAt = time.Now()
		info := c.snapshotLocked()
		c.mu.Unlock()
		return info, nil
	}

	rel, err := c.fetchLatestRelease(ctx)
	if err != nil {
		return c.Info(), err
	}

	c.mu.Lock()
	c.latest = rel.Tag
	c.release = &rel
	if rel.Body != "" || rel.HTMLURL != "" {
		c.changelog = rel.Body
		c.changelogURL = rel.HTMLURL
	}
	c.checkedAt = time.Now()
	info := c.snapshotLocked()
	c.mu.Unlock()
	return info, nil
}

// Start runs an initial check shortly after launch, then refreshes every
// PollInterval until ctx is cancelled. Intended to be run in its own goroutine.
func (c *Checker) Start(ctx context.Context) {
	if c.isDev() {
		return
	}
	// Small delay so startup isn't blocked on the network.
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			checkCtx, cancel := context.WithTimeout(ctx, httpTimeout*2)
			_, _ = c.Check(checkCtx)
			cancel()
			timer.Reset(PollInterval)
		}
	}
}

// LatestAsset resolves the download for the given platform from the latest
// release. platform is "os-arch", e.g. "darwin-arm64" or "windows-amd64";
// asset names match the installers: pican-<os>-<arch> (with an .exe suffix on
// Windows). It uses the cached release when one was already fetched (the same
// tag the UI advertised) so an install never races a mid-publish release;
// otherwise it fetches from the API.
func (c *Checker) LatestAsset(ctx context.Context, platform string) (tag, assetName, downloadURL string, err error) {
	rel, err := c.latestRelease(ctx)
	if err != nil {
		return "", "", "", err
	}
	name := assetNameForPlatform(platform)
	for _, a := range rel.Assets {
		if a.Name == name {
			return rel.Tag, a.Name, a.DownloadURL, nil
		}
	}
	return "", "", "", fmt.Errorf("release %s has no asset for platform %q (expected %q)", rel.Tag, platform, name)
}

// LatestChecksumsURL returns the download URL of the release's sha256sums.txt
// asset, or "" when the release does not include one. The install hook skips
// checksum verification when no checksum asset is present (parity with
// install.sh, which never verifies).
func (c *Checker) LatestChecksumsURL(ctx context.Context) (string, error) {
	rel, err := c.latestRelease(ctx)
	if err != nil {
		return "", err
	}
	for _, a := range rel.Assets {
		if a.Name == "sha256sums.txt" {
			return a.DownloadURL, nil
		}
	}
	return "", nil
}

// latestRelease returns the cached release when available, otherwise a fresh
// API fetch (cached on success).
func (c *Checker) latestRelease(ctx context.Context) (Release, error) {
	c.mu.RLock()
	cached := c.release
	c.mu.RUnlock()
	if cached != nil {
		return *cached, nil
	}
	rel, err := c.fetchLatestRelease(ctx)
	if err != nil {
		return Release{}, err
	}
	c.mu.Lock()
	if c.release == nil {
		c.release = &rel
	}
	rel = *c.release
	c.mu.Unlock()
	return rel, nil
}

// assetNameForPlatform matches the installers: install.sh downloads
// pican-<os>-<arch> for darwin/linux, install.ps1 downloads
// pican-windows-<arch>.exe for windows.
func assetNameForPlatform(platform string) string {
	if strings.HasPrefix(platform, "windows-") {
		return "pican-" + platform + ".exe"
	}
	return "pican-" + platform
}

// fetchLatestRelease reads the newest published release from the GitHub
// Releases API. 404 means the repository has no release yet; the 403/429 rate
// limit case suggests setting GITHUB_TOKEN. The release body doubles as the
// changelog.
func (c *Checker) fetchLatestRelease(ctx context.Context) (Release, error) {
	url := c.githubAPI + "/releases/latest"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "pican-updater")
	if token := githubToken(); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return Release{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Release{}, err
	}
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return Release{}, fmt.Errorf("GitHub has no published release for Yeshwanthyk/pican yet (GET %s)", url)
	case http.StatusForbidden, http.StatusTooManyRequests:
		return Release{}, fmt.Errorf("GitHub API rate limit exceeded (GET %s); set GITHUB_TOKEN to raise the limit", url)
	default:
		return Release{}, fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}

	var doc struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Body    string `json:"body"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return Release{}, fmt.Errorf("parse GitHub release response: %w", err)
	}
	if doc.TagName == "" {
		return Release{}, fmt.Errorf("GitHub release response is missing tag_name (GET %s)", url)
	}
	rel := Release{Tag: doc.TagName, HTMLURL: doc.HTMLURL, Body: doc.Body}
	for _, a := range doc.Assets {
		rel.Assets = append(rel.Assets, Asset{Name: a.Name, DownloadURL: a.BrowserDownloadURL})
	}
	return rel, nil
}

func githubToken() string {
	return os.Getenv("GITHUB_TOKEN")
}

// compareSemver compares two semver strings (optionally "v"-prefixed, with an
// optional prerelease suffix like "-beta.24"). It returns -1, 0, or 1.
// A release version outranks any prerelease with the same core (per semver).
func compareSemver(a, b string) int {
	coreA, preA := splitVersion(a)
	coreB, preB := splitVersion(b)

	for i := 0; i < 3; i++ {
		if coreA[i] != coreB[i] {
			if coreA[i] < coreB[i] {
				return -1
			}
			return 1
		}
	}
	return comparePrerelease(preA, preB)
}

// splitVersion parses "v1.2.3-beta.4" into [1,2,3] and "beta.4". Missing
// numeric parts default to 0; unparseable parts are treated as 0.
func splitVersion(v string) ([3]int, string) {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	core := v
	pre := ""
	if i := strings.IndexByte(v, '-'); i >= 0 {
		core = v[:i]
		pre = v[i+1:]
	}
	// Drop build metadata.
	if i := strings.IndexByte(core, '+'); i >= 0 {
		core = core[:i]
	}
	if i := strings.IndexByte(pre, '+'); i >= 0 {
		pre = pre[:i]
	}
	var nums [3]int
	for i, part := range strings.SplitN(core, ".", 3) {
		if i > 2 {
			break
		}
		nums[i], _ = strconv.Atoi(strings.TrimSpace(part))
	}
	return nums, pre
}

// comparePrerelease implements semver prerelease precedence: no prerelease
// outranks a prerelease; otherwise dot-separated identifiers are compared,
// numeric < non-numeric, numerics compared as integers.
func comparePrerelease(a, b string) int {
	if a == b {
		return 0
	}
	if a == "" {
		return 1 // release > prerelease
	}
	if b == "" {
		return -1
	}
	pa := strings.Split(a, ".")
	pb := strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		if c := compareIdentifier(pa[i], pb[i]); c != 0 {
			return c
		}
	}
	switch {
	case len(pa) < len(pb):
		return -1
	case len(pa) > len(pb):
		return 1
	default:
		return 0
	}
}

func compareIdentifier(a, b string) int {
	na, errA := strconv.Atoi(a)
	nb, errB := strconv.Atoi(b)
	bothNumeric := errA == nil && errB == nil
	switch {
	case bothNumeric:
		switch {
		case na < nb:
			return -1
		case na > nb:
			return 1
		default:
			return 0
		}
	case errA == nil: // numeric < non-numeric
		return -1
	case errB == nil:
		return 1
	default:
		return strings.Compare(a, b)
	}
}
