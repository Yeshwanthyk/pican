package claude

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"pican/internal/runtimes"
)

// Catalog projects the configured Claude home's direct project transcripts.
// Native membership is authoritative only after a complete scan.
type Catalog struct {
	home        string
	projectsDir string
	sessionsDir string
	mu          sync.Mutex
	files       map[string]catalogFileState
}

type fileFingerprint struct {
	modTime int64
	size    int64
}

type catalogFileState struct {
	fingerprint  fileFingerprint
	nativeID     string
	updatedAt    int64
	complete     bool
	projection   string
	materialized bool
}

type catalogCandidate struct {
	state      catalogFileState
	transcript *Transcript
}

func NewCatalog(home, sessionsDir string) (*Catalog, error) {
	if strings.TrimSpace(home) == "" || strings.TrimSpace(sessionsDir) == "" {
		return nil, errors.New("Claude catalog requires home and sessions directory")
	}
	absoluteHome, err := filepath.Abs(home)
	if err != nil {
		return nil, err
	}
	absoluteSessions, err := filepath.Abs(sessionsDir)
	if err != nil {
		return nil, err
	}
	return &Catalog{
		home:        filepath.Clean(absoluteHome),
		projectsDir: filepath.Join(filepath.Clean(absoluteHome), "projects"),
		sessionsDir: filepath.Clean(absoluteSessions),
		files:       make(map[string]catalogFileState),
	}, nil
}

func (c *Catalog) Home() string        { return c.home }
func (c *Catalog) ProjectsDir() string { return c.projectsDir }

func (c *Catalog) Sync(ctx context.Context) (runtimes.CatalogResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.syncLocked(ctx)
}

func (c *Catalog) syncLocked(ctx context.Context) (runtimes.CatalogResult, error) {
	initial, initialErr := FindProjections(c.sessionsDir)
	paths, complete, scanErr := c.scanPaths()
	if scanErr != nil {
		return runtimes.CatalogResult{Complete: false}, scanErr
	}
	if initialErr != nil {
		complete = false
	}

	candidates := make(map[string]catalogCandidate)
	chosenPath := make(map[string]string)
	seenPaths := make(map[string]struct{}, len(paths))
	var operationalErrors []error
	for _, path := range paths {
		seenPaths[path] = struct{}{}
		if err := ctx.Err(); err != nil {
			return runtimes.CatalogResult{Complete: false}, err
		}
		info, err := os.Lstat(path)
		if err != nil {
			complete = false
			continue
		}
		fingerprint := fingerprintFor(info)
		state, unchanged := c.files[path]
		var transcript *Transcript
		if !unchanged || state.fingerprint != fingerprint {
			parsed, parseErr := ParseTranscript(path)
			if parseErr != nil {
				// Empty, incomplete, or individually unreadable files make this
				// scan partial but cannot hide other sessions or authorize pruning.
				complete = false
				continue
			}
			transcript = &parsed
			state = catalogFileState{
				fingerprint: fingerprint,
				nativeID:    parsed.NativeID,
				updatedAt:   parsed.UpdatedAt.UnixNano(),
				complete:    parsed.Complete,
				projection:  "claude-" + parsed.NativeID,
			}
			c.files[path] = state
		}
		if !state.complete {
			complete = false
		}
		if current, duplicate := candidates[state.nativeID]; duplicate {
			complete = false
			if state.updatedAt < current.state.updatedAt || (state.updatedAt == current.state.updatedAt && path >= chosenPath[state.nativeID]) {
				continue
			}
		}
		candidates[state.nativeID] = catalogCandidate{state: state, transcript: transcript}
		chosenPath[state.nativeID] = path
	}

	nativeIDs := make([]string, 0, len(candidates))
	for nativeID := range candidates {
		nativeIDs = append(nativeIDs, nativeID)
	}
	sort.Strings(nativeIDs)
	result := runtimes.CatalogResult{Complete: complete}
	listed := make(map[string]struct{}, len(nativeIDs))
	for _, nativeID := range nativeIDs {
		candidate := candidates[nativeID]
		projectionID := candidate.state.projection
		projectionPath, projected := initial[nativeID]
		if projected {
			projectionID = filepath.Base(projectionPath)
		}
		if !candidate.state.materialized || !projected {
			transcript := candidate.transcript
			if transcript == nil {
				parsed, err := ParseTranscript(chosenPath[nativeID])
				if err != nil {
					result.Complete = false
					operationalErrors = append(operationalErrors, fmt.Errorf("parse Claude session %s: %w", nativeID, err))
					continue
				}
				transcript = &parsed
			}
			projection, err := Materialize(c.sessionsDir, *transcript)
			if err != nil {
				result.Complete = false
				operationalErrors = append(operationalErrors, fmt.Errorf("materialize Claude session %s: %w", nativeID, err))
				continue
			}
			projectionID = projection.ID
			for path, existing := range c.files {
				if existing.nativeID == nativeID {
					existing.materialized = false
					c.files[path] = existing
				}
			}
			candidate.state.materialized = true
		}
		listed[nativeID] = struct{}{}
		result.SessionIDs = append(result.SessionIDs, projectionID)
		c.files[chosenPath[nativeID]] = candidate.state
	}
	for path := range c.files {
		if _, exists := seenPaths[path]; !exists {
			delete(c.files, path)
		}
	}

	if result.Complete {
		finalPaths, finalComplete, err := c.scanPaths()
		if err != nil {
			result.Complete = false
			operationalErrors = append(operationalErrors, fmt.Errorf("verify Claude catalog membership: %w", err))
		} else if !finalComplete || !equalPaths(paths, finalPaths) {
			// A directory-level create/remove can occur after the initial path
			// listing without changing any file snapshot already parsed. Treat
			// membership as partial rather than pruning from a stale listing.
			result.Complete = false
		}
	}
	if result.Complete {
		for nativeID, path := range initial {
			if _, exists := listed[nativeID]; exists {
				continue
			}
			metadata, metadataErr := ReadProjectionMetadata(path)
			if metadataErr != nil {
				result.Complete = false
				operationalErrors = append(operationalErrors, fmt.Errorf("validate Claude projection %s: %w", nativeID, metadataErr))
				continue
			}
			// A fresh pican-created session has no native file until its first
			// prompt. It is creation intent, not transcript authority, and must
			// survive periodic complete scans and process reaping.
			if metadata.Fresh {
				continue
			}
			if err := RemoveProjection(c.sessionsDir, path, nativeID); err != nil && !errors.Is(err, os.ErrNotExist) {
				result.Complete = false
				operationalErrors = append(operationalErrors, fmt.Errorf("remove stale Claude projection %s: %w", nativeID, err))
			}
		}
	}
	if initialErr != nil {
		operationalErrors = append(operationalErrors, fmt.Errorf("scan Claude projections: %w", initialErr))
	}
	return result, errors.Join(operationalErrors...)
}

// RefreshPath updates one changed transcript and never removes projections.
func (c *Catalog) NativeExists(nativeID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.findNativePathLocked(nativeID)
	return err == nil
}

// RefreshNative finds a native transcript by validated UUID, materializes its
// current stable snapshot, and reports whether the assistant message expected
// by the live worker is now present. It never writes under the Claude home.
func (c *Catalog) RefreshNative(ctx context.Context, nativeID, expectedMessageID string) (Projection, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Projection{}, false, err
	}
	path, err := c.findNativePathLocked(nativeID)
	if err != nil {
		return Projection{}, false, err
	}
	transcript, err := ParseTranscript(path)
	if err != nil {
		return Projection{}, false, err
	}
	projection, err := Materialize(c.sessionsDir, transcript)
	if err != nil {
		return Projection{}, false, err
	}
	c.rememberFile(path, transcript, projection.ID)
	if !transcript.Stable {
		return projection, false, nil
	}
	if expectedMessageID == "" {
		return projection, true, nil
	}
	for _, record := range transcript.Records {
		if record.Message != nil && record.Message.ID == expectedMessageID {
			return projection, true, nil
		}
	}
	return projection, false, nil
}

func (c *Catalog) findNativePathLocked(nativeID string) (string, error) {
	if _, err := nativeIDFromPath(nativeID + ".jsonl"); err != nil {
		return "", err
	}
	projects, err := os.ReadDir(c.projectsDir)
	if err != nil {
		return "", err
	}
	var found string
	for _, project := range projects {
		if !project.IsDir() || project.Type()&os.ModeSymlink != 0 {
			continue
		}
		candidate := filepath.Join(c.projectsDir, project.Name(), nativeID+".jsonl")
		info, statErr := os.Lstat(candidate)
		if errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if statErr != nil {
			return "", statErr
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("Claude transcript is not a regular file")
		}
		if found != "" {
			return "", fmt.Errorf("multiple Claude transcripts for native session %s", nativeID)
		}
		found = candidate
	}
	if found == "" {
		return "", os.ErrNotExist
	}
	return found, nil
}

func (c *Catalog) RefreshPath(ctx context.Context, path string) (Projection, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.validateNativePath(path); err != nil {
		return Projection{}, false, err
	}
	if err := ctx.Err(); err != nil {
		return Projection{}, false, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return Projection{}, false, nil
	}
	if err != nil {
		return Projection{}, false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return Projection{}, false, errors.New("Claude transcript is not a regular file")
	}
	transcript, err := ParseTranscript(path)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, ErrNoTranscriptRecords) {
		return Projection{}, false, nil
	}
	if err != nil {
		return Projection{}, false, err
	}
	projection, err := Materialize(c.sessionsDir, transcript)
	if err != nil {
		return Projection{}, false, err
	}
	c.rememberFile(path, transcript, projection.ID)
	return projection, true, nil
}

func fingerprintFor(info os.FileInfo) fileFingerprint {
	return fileFingerprint{modTime: info.ModTime().UnixNano(), size: info.Size()}
}

func (c *Catalog) rememberFile(path string, transcript Transcript, projectionID string) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	c.files[path] = catalogFileState{
		fingerprint:  fingerprintFor(info),
		nativeID:     transcript.NativeID,
		updatedAt:    transcript.UpdatedAt.UnixNano(),
		complete:     transcript.Complete,
		projection:   projectionID,
		materialized: true,
	}
}

func (c *Catalog) scanPaths() ([]string, bool, error) {
	projects, err := os.ReadDir(c.projectsDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, true, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("scan Claude projects %s: %w", c.projectsDir, err)
	}
	complete := true
	var paths []string
	for _, project := range projects {
		if !project.IsDir() || project.Type()&os.ModeSymlink != 0 {
			continue
		}
		projectPath := filepath.Join(c.projectsDir, project.Name())
		files, err := os.ReadDir(projectPath)
		if err != nil {
			complete = false
			continue
		}
		for _, file := range files {
			if file.IsDir() || file.Type()&os.ModeSymlink != 0 || filepath.Ext(file.Name()) != ".jsonl" {
				continue
			}
			info, err := file.Info()
			if err != nil {
				complete = false
				continue
			}
			if !info.Mode().IsRegular() {
				complete = false
				continue
			}
			paths = append(paths, filepath.Join(projectPath, file.Name()))
		}
	}
	sort.Strings(paths)
	return paths, complete, nil
}

func equalPaths(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func (c *Catalog) validateNativePath(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(c.projectsDir, filepath.Clean(absolute))
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("Claude transcript path is outside the configured home")
	}
	parts := strings.Split(relative, string(filepath.Separator))
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || filepath.Ext(parts[1]) != ".jsonl" {
		return errors.New("invalid Claude transcript path")
	}
	return nil
}
