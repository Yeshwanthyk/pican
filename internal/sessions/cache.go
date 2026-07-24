package sessions

import (
	"container/list"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const defaultSessionCacheByteBudget int64 = 200 << 20

type cacheEntry struct {
	modTime time.Time
	dirName string
	summary SessionSummary
	parse   parseState
}

type sessionCacheEntry struct {
	modTime time.Time
	session Session
	parse   fileParseState
	path    string
	bytes   int64
}

// dirListing is a project directory's cached file-name list (.jsonl only),
// valid as long as the directory's own modTime hasn't changed. A directory's
// modTime advances when an entry is added, removed, or renamed — but NOT when
// an existing file is merely appended to — so this only ever caches names,
// never per-file modTime/size; those are always freshly stat'd (see LoadAll).
type dirListing struct {
	modTime time.Time
	names   []string
}

type Cache struct {
	mu            sync.Mutex
	entries       map[string]cacheEntry    // keyed by full file path
	pathIndex     map[string]string        // filename -> full file path
	sessionCache  map[string]*list.Element // path -> element in sessionLRU
	sessionLRU    list.List                // most recently used at the front
	sessionBytes  int64
	sessionBudget int64

	rootDir     string
	hasRoot     bool
	rootModTime time.Time
	projectDirs []string              // subdirectory names under rootDir, valid while rootModTime matches
	dirListings map[string]dirListing // project dir name -> cached .jsonl name list

	parses           int // diagnostic: number of ParseSummary calls
	hits             int // diagnostic: number of cache hits
	sessionParses    int // diagnostic: number of full-session parse calls
	sessionHits      int // diagnostic: number of full-session cache hits
	sessionEvictions int
	dirReads         int // diagnostic: number of real os.ReadDir calls issued (root + subdirs)
}

type CacheOption func(*Cache)

// WithSessionCacheByteBudget overrides the parsed-session cache budget. A
// non-positive budget disables retention while preserving Resolve behavior.
func WithSessionCacheByteBudget(bytes int64) CacheOption {
	return func(c *Cache) {
		c.sessionBudget = bytes
	}
}

func NewCache(options ...CacheOption) *Cache {
	c := &Cache{
		entries:       make(map[string]cacheEntry),
		pathIndex:     make(map[string]string),
		sessionCache:  make(map[string]*list.Element),
		sessionBudget: defaultSessionCacheByteBudget,
		dirListings:   make(map[string]dirListing),
	}
	for _, option := range options {
		option(c)
	}
	return c
}

// CacheStats is a point-in-time diagnostic snapshot used by /api/metrics.
type CacheStats struct {
	SummaryParses    int
	SummaryHits      int
	SessionParses    int
	SessionHits      int
	SessionEntries   int
	SessionBytes     int64
	SessionEvictions int
}

func (c *Cache) Stats() CacheStats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return CacheStats{
		SummaryParses:    c.parses,
		SummaryHits:      c.hits,
		SessionParses:    c.sessionParses,
		SessionHits:      c.sessionHits,
		SessionEntries:   len(c.sessionCache),
		SessionBytes:     c.sessionBytes,
		SessionEvictions: c.sessionEvictions,
	}
}

func (c *Cache) removeSessionEntryLocked(path string) {
	elem, ok := c.sessionCache[path]
	if !ok {
		return
	}
	entry := elem.Value.(*sessionCacheEntry)
	c.sessionBytes -= entry.bytes
	c.sessionLRU.Remove(elem)
	delete(c.sessionCache, path)
}

func (c *Cache) storeSessionEntryLocked(entry sessionCacheEntry) {
	c.removeSessionEntryLocked(entry.path)
	elem := c.sessionLRU.PushFront(&entry)
	c.sessionCache[entry.path] = elem
	c.sessionBytes += entry.bytes
	for c.sessionBytes > c.sessionBudget && c.sessionLRU.Len() > 0 {
		oldest := c.sessionLRU.Back()
		oldEntry := oldest.Value.(*sessionCacheEntry)
		c.removeSessionEntryLocked(oldEntry.path)
		c.sessionEvictions++
	}
}

func approximateSessionBytes(session Session) int64 {
	size := int64(256)
	size += int64(len(session.ID) + len(session.SessionUUID) + len(session.Filename) +
		len(session.Name) + len(session.Project) + len(session.Runtime) +
		len(session.NativeID) + len(session.LastActivity))
	size += approximateValueBytes(session.Header)
	size += 24
	for _, entry := range session.Entries {
		size += approximateValueBytes(entry)
	}
	return size
}

func approximateValueBytes(value any) int64 {
	switch value := value.(type) {
	case nil:
		return 0
	case bool, float64, int, int64, uint64:
		return 16
	case string:
		return int64(16 + len(value))
	case []any:
		size := int64(24 + 16*len(value))
		for _, item := range value {
			size += approximateValueBytes(item)
		}
		return size
	case map[string]any:
		size := int64(64 + 32*len(value))
		for key, item := range value {
			size += int64(len(key)) + approximateValueBytes(item)
		}
		return size
	default:
		return 16
	}
}

// discoverProjectDirs returns the subdirectory names directly under dir,
// reusing the previous call's list when dir's own modTime hasn't changed
// (nothing added/removed/renamed at that level) instead of issuing a fresh
// os.ReadDir.
func (c *Cache) discoverProjectDirs(dir string, rootModTime time.Time) ([]string, error) {
	c.mu.Lock()
	if c.hasRoot && c.rootDir == dir && c.rootModTime.Equal(rootModTime) {
		cached := c.projectDirs
		c.mu.Unlock()
		return cached, nil
	}
	c.mu.Unlock()

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	projectDirs := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			projectDirs = append(projectDirs, e.Name())
		}
	}

	c.mu.Lock()
	c.dirReads++
	c.rootDir = dir
	c.rootModTime = rootModTime
	c.hasRoot = true
	c.projectDirs = projectDirs
	// Prune listings for project dirs that no longer exist so the map
	// doesn't grow forever across renames/deletions.
	keep := make(map[string]struct{}, len(projectDirs))
	for _, name := range projectDirs {
		keep[name] = struct{}{}
	}
	for name := range c.dirListings {
		if _, ok := keep[name]; !ok {
			delete(c.dirListings, name)
		}
	}
	c.mu.Unlock()

	return projectDirs, nil
}

// discoverSessionNames returns the .jsonl file names directly under subDir,
// reusing the cached listing when subDir's own modTime hasn't changed.
func (c *Cache) discoverSessionNames(dirName, subDir string, subModTime time.Time) ([]string, error) {
	c.mu.Lock()
	listing, ok := c.dirListings[dirName]
	c.mu.Unlock()
	if ok && listing.modTime.Equal(subModTime) {
		return listing.names, nil
	}

	subs, err := os.ReadDir(subDir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(subs))
	for _, f := range subs {
		if !f.IsDir() && strings.HasSuffix(f.Name(), ".jsonl") {
			names = append(names, f.Name())
		}
	}

	c.mu.Lock()
	c.dirReads++
	c.dirListings[dirName] = dirListing{modTime: subModTime, names: names}
	c.mu.Unlock()

	return names, nil
}

// LoadAll returns summaries for every session under dir. Files whose modtime
// hasn't changed since the previous call are returned from the cache; files
// that are new or modified are re-parsed; files that have disappeared are
// evicted. It also maintains a path index for O(1) lookup by filename.
//
// Directory discovery (which project dirs exist, which files each contains)
// is memoized per-directory, gated by that directory's own modTime: an
// unchanged directory skips its os.ReadDir entirely. Only the file names are
// cached this way — every file's modTime/size is still freshly stat'd on
// every call, because an append to an existing file does NOT change its
// parent directory's modTime, so a cached modTime would go stale silently.
func (c *Cache) LoadAll(dir string) ([]SessionSummary, error) {
	rootInfo, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}

	projectDirs, err := c.discoverProjectDirs(dir, rootInfo.ModTime())
	if err != nil {
		return nil, err
	}

	// Collect all files to consider, along with their info, before locking.
	type fileRecord struct {
		path    string
		dirName string
		name    string
		modTime time.Time
	}
	var records []fileRecord
	for _, dirName := range projectDirs {
		subDir := filepath.Join(dir, dirName)
		subInfo, err := os.Stat(subDir)
		if err != nil {
			continue
		}
		names, err := c.discoverSessionNames(dirName, subDir, subInfo.ModTime())
		if err != nil {
			continue
		}
		for _, name := range names {
			path := filepath.Join(subDir, name)
			// Always stat individually: the directory's mtime only proves the
			// set of names is unchanged, not that an existing file's own
			// mtime/size didn't advance via an append.
			info, err := os.Stat(path)
			if err != nil {
				continue
			}
			records = append(records, fileRecord{
				path:    path,
				dirName: dirName,
				name:    name,
				modTime: info.ModTime(),
			})
		}
	}

	c.mu.Lock()

	// Determine which files need parsing (new or modified).
	type parseWork struct {
		rec   fileRecord
		prior *cacheEntry // previous parse state, if any — enables an incremental tail parse (see incremental.go)
	}
	var toparse []parseWork
	seen := make(map[string]struct{}, len(records))
	cached := make([]SessionSummary, 0, len(records))

	for _, rec := range records {
		seen[rec.path] = struct{}{}
		ce, ok := c.entries[rec.path]
		if ok && ce.modTime.Equal(rec.modTime) && ce.dirName == rec.dirName {
			c.hits++
			cached = append(cached, ce.summary)
			continue
		}
		var prior *cacheEntry
		if ok {
			priorCopy := ce
			prior = &priorCopy
		}
		toparse = append(toparse, parseWork{rec: rec, prior: prior})
	}

	// Evict files no longer present.
	for p := range c.entries {
		if _, ok := seen[p]; !ok {
			delete(c.entries, p)
			delete(c.pathIndex, filepath.Base(p))
			c.removeSessionEntryLocked(p)
		}
	}
	for p := range c.sessionCache {
		if _, ok := seen[p]; !ok {
			delete(c.pathIndex, filepath.Base(p))
			c.removeSessionEntryLocked(p)
		}
	}

	c.mu.Unlock()

	if len(toparse) == 0 {
		SortSummariesByActivity(cached)
		return cached, nil
	}

	// Parse files concurrently.
	type result struct {
		rec     fileRecord
		summary SessionSummary
		state   parseState
		err     error
	}
	results := make([]result, len(toparse))
	var wg sync.WaitGroup
	// Use higher concurrency — SSDs handle many concurrent reads well.
	concurrency := len(toparse)
	if concurrency > 32 {
		concurrency = 32
	}
	if concurrency < 1 {
		concurrency = 1
	}
	sem := make(chan struct{}, concurrency)
	for i, w := range toparse {
		wg.Add(1)
		go func(i int, w parseWork) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			summary, state, err := parseSummaryCached(w.rec.path, w.rec.dirName, w.rec.name, w.prior)
			results[i] = result{rec: w.rec, summary: summary, state: state, err: err}
		}(i, w)
	}
	wg.Wait()

	c.mu.Lock()
	summaries := make([]SessionSummary, 0, len(records))
	summaries = append(summaries, cached...)
	for _, res := range results {
		if res.err != nil {
			continue
		}
		c.parses++
		c.entries[res.rec.path] = cacheEntry{
			modTime: res.rec.modTime,
			dirName: res.rec.dirName,
			summary: res.summary,
			parse:   res.state,
		}
		c.pathIndex[res.rec.name] = res.rec.path
		summaries = append(summaries, res.summary)
	}
	// Rebuild pathIndex for all cached entries too (idempotent).
	for path, ce := range c.entries {
		name := filepath.Base(path)
		if _, exists := c.pathIndex[name]; !exists {
			c.pathIndex[name] = path
			_ = ce
		}
	}
	c.mu.Unlock()

	SortSummariesByActivity(summaries)
	return summaries, nil
}

// FindPath returns the full filesystem path for a session filename, using the
// in-memory path index built by LoadAll. Returns ("", false) if not found.
func (c *Cache) FindPath(name string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.pathIndex[name]
	return p, ok
}

// ResolveSummary resolves one session without retaining its full Entries and
// Header maps. It is intended for hot metadata-only paths such as worker
// status checks.
func (c *Cache) ResolveSummary(sessionsDir, id string) (SessionSummary, error) {
	if id == "" || filepath.Base(id) != id || filepath.Ext(id) != ".jsonl" {
		return SessionSummary{}, ErrInvalidSessionID
	}

	path, ok := c.FindPath(id)
	if !ok {
		var err error
		path, err = findPathByFilename(sessionsDir, id)
		if err != nil {
			return SessionSummary{}, err
		}
		c.mu.Lock()
		c.pathIndex[id] = path
		c.mu.Unlock()
	}

	info, err := os.Stat(path)
	if err != nil {
		c.mu.Lock()
		delete(c.pathIndex, id)
		delete(c.entries, path)
		c.removeSessionEntryLocked(path)
		c.mu.Unlock()
		return SessionSummary{}, err
	}

	c.mu.Lock()
	entry, cached := c.entries[path]
	if cached && entry.modTime.Equal(info.ModTime()) {
		c.hits++
		c.mu.Unlock()
		return entry.summary, nil
	}
	if elem, ok := c.sessionCache[path]; ok {
		full := elem.Value.(*sessionCacheEntry)
		if full.modTime.Equal(info.ModTime()) {
			// Metadata-only status polling must not keep a large parsed session
			// artificially hot in the LRU, so don't move this element.
			c.hits++
			summary := full.session.SessionSummary
			c.mu.Unlock()
			return summary, nil
		}
	}
	var prior *cacheEntry
	if cached {
		priorCopy := entry
		prior = &priorCopy
	}
	c.mu.Unlock()

	dirName := filepath.Base(filepath.Dir(path))
	summary, state, err := parseSummaryCached(path, dirName, id, prior)
	if err != nil {
		return SessionSummary{}, err
	}
	c.mu.Lock()
	c.parses++
	c.entries[path] = cacheEntry{
		modTime: info.ModTime(),
		dirName: dirName,
		summary: summary,
		parse:   state,
	}
	c.pathIndex[id] = path
	c.mu.Unlock()
	return summary, nil
}

// Invalidate drops parsed data and path resolution for a session. Runtime-backed
// projections may be atomically replaced or moved between canonicalized project
// directories, so the next read must rediscover the authoritative path rather
// than relying on modtime precision or a stale filename index.
func (c *Cache) Invalidate(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.pathIndex, id)
	for path := range c.sessionCache {
		if filepath.Base(path) == id {
			c.removeSessionEntryLocked(path)
		}
	}
	for path := range c.entries {
		if filepath.Base(path) == id {
			delete(c.entries, path)
		}
	}
}

// Resolve resolves a session by filename ID. It tries the in-memory path index
// first (O(1)) and falls back to a directory scan if the index is cold.
// Parsed sessions are cached by modtime so repeated reads of unchanged files
// skip disk I/O entirely.
func (c *Cache) Resolve(sessionsDir, id string) (ResolvedSession, error) {
	if id == "" || filepath.Base(id) != id || filepath.Ext(id) != ".jsonl" {
		return ResolvedSession{}, ErrInvalidSessionID
	}

	path, ok := c.FindPath(id)
	if !ok {
		var err error
		path, err = findPathByFilename(sessionsDir, id)
		if err != nil {
			return ResolvedSession{}, err
		}
		c.mu.Lock()
		c.pathIndex[id] = path
		c.mu.Unlock()
	}

	info, err := os.Stat(path)
	if err != nil {
		c.mu.Lock()
		delete(c.pathIndex, id)
		delete(c.entries, path)
		c.removeSessionEntryLocked(path)
		c.mu.Unlock()
		return ResolvedSession{}, err
	}
	modTime := info.ModTime()

	c.mu.Lock()
	elem, hasCached := c.sessionCache[path]
	var ce sessionCacheEntry
	if hasCached {
		ce = *elem.Value.(*sessionCacheEntry)
	}
	if hasCached && ce.modTime.Equal(modTime) {
		c.sessionLRU.MoveToFront(elem)
		c.sessionHits++
	}
	c.mu.Unlock()

	if hasCached && ce.modTime.Equal(modTime) {
		return ResolvedSession{Session: ce.session, Path: path}, nil
	}

	var prior *sessionCacheEntry
	if hasCached {
		priorCopy := ce
		prior = &priorCopy
	}

	sess, state, err := parseFileCached(path, filepath.Base(filepath.Dir(path)), id, prior)
	if err != nil {
		return ResolvedSession{}, err
	}

	c.mu.Lock()
	c.sessionParses++
	c.storeSessionEntryLocked(sessionCacheEntry{
		modTime: modTime,
		session: sess,
		parse:   state,
		path:    path,
		bytes:   approximateSessionBytes(sess),
	})
	c.mu.Unlock()

	return ResolvedSession{Session: sess, Path: path}, nil
}
