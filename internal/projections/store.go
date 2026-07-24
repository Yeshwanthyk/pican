// Package projections owns the runtime-neutral persistence mechanics for
// rebuildable session projections. Native runtimes remain authoritative; this
// package only manages their validated, replaceable pican JSONL views.
package projections

import (
	"bufio"
	"bytes"
	"container/list"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"pican/internal/runtimes"
	"pican/internal/sessions"
)

const (
	maxLineBytes              = 32 << 20
	maxProjectionFingerprints = 8192
)

var identityLocks keyedLocker
var projectionFingerprints fingerprintCache

type projectionFingerprint struct {
	info        os.FileInfo
	changeStamp string
	hash        [sha256.Size]byte
}

type fingerprintEntry struct {
	path        string
	fingerprint projectionFingerprint
}

type fingerprintCache struct {
	mu      sync.Mutex
	entries map[string]*list.Element
	order   list.List
}

// Metadata is the trusted projection-header identity shared by replaceable
// runtimes. Runtime-specific adapters may validate additional header fields.
type Metadata struct {
	Runtime  string
	NativeID string
	CWD      string
}

// Projection identifies a materialized pican session projection.
type Projection struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	NativeID string `json:"nativeId"`
}

// Store manages projections for one runtime below one sessions directory.
type Store struct {
	sessionsDir string
	lockRoot    string
	runtime     string
}

// NewStore validates the runtime identity used in projection headers and
// filenames. The sessions directory need not exist yet.
func NewStore(sessionsDir, runtime string) (*Store, error) {
	id, err := runtimes.ParseID(runtime)
	if err != nil {
		return nil, err
	}
	root, err := filepath.Abs(sessionsDir)
	if err != nil {
		return nil, err
	}
	root = filepath.Clean(root)
	lockRoot := root
	if resolved, err := filepath.EvalSymlinks(lockRoot); err == nil {
		lockRoot = resolved
	}
	return &Store{sessionsDir: root, lockRoot: filepath.Clean(lockRoot), runtime: string(id)}, nil
}

// CanonicalCWD makes project identity stable across relative paths and
// filesystem symlink aliases (for example /tmp and /private/tmp on macOS).
func CanonicalCWD(path string) string {
	absolute, err := filepath.Abs(path)
	if err == nil {
		path = absolute
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	return filepath.Clean(path)
}

// Path derives the only projection path this store may write for an identity.
func (s *Store) Path(nativeID, cwd string) (string, error) {
	if nativeID == "" || cwd == "" {
		return "", errors.New("projection requires native id and cwd")
	}
	if err := validateNativeID(nativeID); err != nil {
		return "", err
	}
	canonical := CanonicalCWD(cwd)
	return filepath.Join(
		s.sessionsDir,
		sessions.EncodeProjectName(canonical),
		s.runtime+"-"+nativeID+".jsonl",
	), nil
}

// ReadMetadata validates the path shape and its runtime/native identity.
func (s *Store) ReadMetadata(path string) (Metadata, error) {
	clean, filenameNativeID, err := s.validatePath(path)
	if err != nil {
		return Metadata{}, err
	}
	f, err := os.Open(clean)
	if err != nil {
		return Metadata{}, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), maxLineBytes)
	for scanner.Scan() {
		var entry struct {
			Type     string `json:"type"`
			Runtime  string `json:"runtime"`
			NativeID string `json:"nativeId"`
			CWD      string `json:"cwd"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			return Metadata{}, fmt.Errorf("decode %s projection: %w", s.runtime, err)
		}
		if entry.Type != "session" {
			continue
		}
		if entry.Runtime != s.runtime || entry.NativeID == "" || entry.CWD == "" || entry.NativeID != filenameNativeID {
			return Metadata{}, fmt.Errorf("invalid %s projection metadata", s.runtime)
		}
		return Metadata{Runtime: entry.Runtime, NativeID: entry.NativeID, CWD: entry.CWD}, nil
	}
	if err := scanner.Err(); err != nil {
		return Metadata{}, err
	}
	return Metadata{}, fmt.Errorf("invalid %s projection metadata", s.runtime)
}

// Find returns validated projections keyed by native session ID. Invalid or
// foreign JSONL files are ignored; filesystem traversal errors are returned.
func (s *Store) Find() (map[string]string, error) {
	return s.FindValidated(nil)
}

// FindValidated additionally lets a runtime adapter reject projections whose
// runtime-specific trusted metadata is invalid.
func (s *Store) FindValidated(validate func(path string, metadata Metadata) error) (map[string]string, error) {
	out := map[string]string{}
	err := filepath.WalkDir(s.sessionsDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), s.runtime+"-") || filepath.Ext(entry.Name()) != ".jsonl" {
			return nil
		}
		metadata, err := s.ReadMetadata(path)
		if err == nil && (validate == nil || validate(path, metadata) == nil) {
			out[metadata.NativeID] = path
		}
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	return out, err
}

// ReplaceBuild runs under the projection identity lock. existing contains the
// target, when present, plus validated duplicate paths for the same native ID.
// The adapter builds only authoritative/runtime-owned entries; Store appends
// preserved pican-local metadata before committing.
type ReplaceBuild func(existing []string) ([]map[string]any, error)

// Replace atomically writes a projection, preserves pican-local metadata, and
// removes validated duplicates left at older cwd-derived paths.
func (s *Store) Replace(nativeID, cwd string, build ReplaceBuild) (Projection, error) {
	target, err := s.Path(nativeID, cwd)
	if err != nil {
		return Projection{}, err
	}
	canonicalCWD := CanonicalCWD(cwd)
	unlock := identityLocks.lock(s.identityKey(nativeID))
	defer unlock()

	paths, err := s.projectionPaths(target, nativeID)
	if err != nil {
		return Projection{}, err
	}
	preserved, err := readLocalEntriesFrom(paths)
	if err != nil {
		return Projection{}, fmt.Errorf("preserve local %s projection entries: %w", s.runtime, err)
	}
	entries, err := build(append([]string(nil), paths...))
	if err != nil {
		return Projection{}, err
	}
	if err := s.validateReplacement(entries, nativeID, canonicalCWD); err != nil {
		return Projection{}, err
	}
	entries = append(entries, preserved...)
	if err := WriteJSONLAtomic(target, entries); err != nil {
		return Projection{}, err
	}
	for _, duplicate := range paths {
		if duplicate == target {
			continue
		}
		metadata, err := s.ReadMetadata(duplicate)
		if err != nil {
			return Projection{}, fmt.Errorf("validate duplicate %s projection: %w", s.runtime, err)
		}
		if metadata.NativeID != nativeID {
			return Projection{}, fmt.Errorf("%s projection native id mismatch", s.runtime)
		}
		if err := os.Remove(duplicate); err != nil && !errors.Is(err, os.ErrNotExist) {
			return Projection{}, fmt.Errorf("remove duplicate %s projection: %w", s.runtime, err)
		}
		forgetProjectionFingerprint(duplicate)
	}
	return Projection{ID: filepath.Base(target), Path: target, NativeID: nativeID}, nil
}

// Remove deletes only the requested path after validating its runtime/native
// identity while holding the same logical lock used by replacement.
func (s *Store) Remove(path, nativeID string) error {
	if err := validateNativeID(nativeID); err != nil {
		return err
	}
	unlock := identityLocks.lock(s.identityKey(nativeID))
	defer unlock()
	metadata, err := s.ReadMetadata(path)
	if err != nil {
		return err
	}
	if metadata.NativeID != nativeID {
		return fmt.Errorf("%s projection native id mismatch", s.runtime)
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	forgetProjectionFingerprint(path)
	return nil
}

// Rename appends pican-owned display metadata without racing replacement.
func (s *Store) Rename(path, name string, now func() time.Time) error {
	return s.mutate(path, func(current string) error {
		return sessions.RenameSession(current, name, now)
	})
}

// AutoTitle appends pican-owned automatic-title metadata without racing
// replacement.
func (s *Store) AutoTitle(path, name string, now func() time.Time) error {
	return s.mutate(path, func(current string) error {
		return sessions.AutoTitleSession(current, name, now)
	})
}

// Label appends pican-owned entry label metadata without racing replacement.
func (s *Store) Label(path, targetID, label string, now func() time.Time) error {
	return s.mutate(path, func(current string) error {
		return sessions.LabelSessionEntry(current, targetID, label, now)
	})
}

// AppendLocal appends a validated pican-owned metadata entry without racing
// replacement. Runtime adapters use this for local settings whose entry shape
// is runtime-specific but whose ownership and serialization are generic.
func (s *Store) AppendLocal(path string, entry map[string]any) error {
	kind, _ := entry["type"].(string)
	if _, ok := localEntryTypes[kind]; !ok {
		return fmt.Errorf("unsupported local projection entry type %q", kind)
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return s.mutate(path, func(current string) error {
		f, err := os.OpenFile(current, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			return err
		}
		defer f.Close()
		if _, err = f.Write(append(data, '\n')); err != nil {
			return err
		}
		return f.Sync()
	})
}

func (s *Store) mutate(path string, mutation func(current string) error) error {
	metadata, err := s.ReadMetadata(path)
	if err != nil {
		return err
	}
	unlock := identityLocks.lock(s.identityKey(metadata.NativeID))
	defer unlock()

	current := path
	validated, err := s.ReadMetadata(current)
	if errors.Is(err, os.ErrNotExist) {
		current, err = s.findIdentityPath(metadata.NativeID)
		if err == nil {
			validated, err = s.ReadMetadata(current)
		}
	}
	if err != nil {
		return err
	}
	if validated.Runtime != metadata.Runtime || validated.NativeID != metadata.NativeID {
		return fmt.Errorf("%s projection identity changed before mutation", s.runtime)
	}
	if err := mutation(current); err != nil {
		return err
	}
	forgetProjectionFingerprint(current)
	return nil
}

func (s *Store) findIdentityPath(nativeID string) (string, error) {
	var found string
	err := filepath.WalkDir(s.sessionsDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || entry.Name() != s.runtime+"-"+nativeID+".jsonl" {
			return nil
		}
		metadata, err := s.ReadMetadata(path)
		if err != nil || metadata.NativeID != nativeID {
			return nil
		}
		if found != "" {
			return fmt.Errorf("multiple %s projections for native id %q", s.runtime, nativeID)
		}
		found = path
		return nil
	})
	if err != nil {
		return "", err
	}
	if found == "" {
		return "", os.ErrNotExist
	}
	return found, nil
}

func (s *Store) projectionPaths(target, nativeID string) ([]string, error) {
	projects, err := os.ReadDir(s.sessionsDir)
	if errors.Is(err, os.ErrNotExist) {
		projects = nil
	} else if err != nil {
		return nil, err
	}
	paths := make([]string, 0, 1)
	if _, err := os.Stat(target); err == nil {
		metadata, metadataErr := s.ReadMetadata(target)
		if metadataErr != nil {
			return nil, fmt.Errorf("validate target %s projection: %w", s.runtime, metadataErr)
		}
		if metadata.NativeID != nativeID {
			return nil, fmt.Errorf("%s projection native id mismatch", s.runtime)
		}
		paths = append(paths, target)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		candidate := filepath.Join(s.sessionsDir, project.Name(), filepath.Base(target))
		if candidate == target {
			continue
		}
		metadata, err := s.ReadMetadata(candidate)
		if err == nil && metadata.NativeID == nativeID {
			paths = append(paths, candidate)
		}
	}
	return paths, nil
}

func (s *Store) validateReplacement(entries []map[string]any, nativeID, canonicalCWD string) error {
	if len(entries) == 0 {
		return errors.New("projection replacement has no session header")
	}
	header := entries[0]
	if header["type"] != "session" || header["runtime"] != s.runtime || header["nativeId"] != nativeID {
		return fmt.Errorf("invalid %s projection replacement identity", s.runtime)
	}
	cwd, _ := header["cwd"].(string)
	if cwd == "" || CanonicalCWD(cwd) != canonicalCWD || cwd != canonicalCWD {
		return fmt.Errorf("invalid %s projection replacement cwd", s.runtime)
	}
	return nil
}

func (s *Store) validatePath(path string) (string, string, error) {
	clean, err := filepath.Abs(path)
	if err != nil {
		return "", "", err
	}
	clean = filepath.Clean(clean)
	rel, err := filepath.Rel(s.sessionsDir, clean)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("projection path is outside sessions directory")
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", errors.New("invalid projection path")
	}
	base := filepath.Base(clean)
	prefix := s.runtime + "-"
	if filepath.Ext(base) != ".jsonl" || !strings.HasPrefix(base, prefix) {
		return "", "", fmt.Errorf("not a %s projection", s.runtime)
	}
	nativeID := strings.TrimSuffix(strings.TrimPrefix(base, prefix), ".jsonl")
	if err := validateNativeID(nativeID); err != nil {
		return "", "", err
	}
	return clean, nativeID, nil
}

func (s *Store) identityKey(nativeID string) string {
	return s.lockRoot + "\x00" + s.runtime + "\x00" + nativeID
}

func validateNativeID(nativeID string) error {
	if nativeID == "" || nativeID == "." || nativeID == ".." || strings.ContainsAny(nativeID, "/\\") || strings.ContainsRune(nativeID, 0) {
		return fmt.Errorf("unsafe projection native id %q", nativeID)
	}
	return nil
}

var localEntryTypes = map[string]struct{}{
	"session_info":          {},
	"label":                 {},
	"model_change":          {},
	"thinking_level_change": {},
}

func readLocalEntriesFrom(paths []string) ([]map[string]any, error) {
	var out []map[string]any
	seen := map[string]struct{}{}
	for _, path := range paths {
		entries, err := readLocalEntries(path)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			key, _ := entry["id"].(string)
			if key == "" {
				encoded, err := json.Marshal(entry)
				if err != nil {
					return nil, err
				}
				key = string(encoded)
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, entry)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		left, _ := out[i]["timestamp"].(string)
		right, _ := out[j]["timestamp"].(string)
		return left < right
	})
	return out, nil
}

func readLocalEntries(path string) ([]map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []map[string]any
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), maxLineBytes)
	line := 0
	for scanner.Scan() {
		line++
		var entry map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			return nil, fmt.Errorf("decode projection line %d: %w", line, err)
		}
		if _, ok := localEntryTypes[fmt.Sprint(entry["type"])]; ok {
			out = append(out, entry)
		}
	}
	return out, scanner.Err()
}

// WriteJSONLAtomic durably replaces path with entries. Identical content is a
// no-op so watchers do not emit false reloads.
func WriteJSONLAtomic(path string, entries []map[string]any) error {
	var data bytes.Buffer
	for _, entry := range entries {
		if err := json.NewEncoder(&data).Encode(entry); err != nil {
			return err
		}
	}
	contentHash := sha256.Sum256(data.Bytes())
	unchanged, err := projectionUnchanged(path, data.Len(), contentHash)
	if err != nil {
		return err
	}
	if unchanged {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".projection-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		_ = f.Close()
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if _, err = f.Write(data.Bytes()); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	writtenInfo, err := f.Stat()
	if err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	renamedInfo, err := os.Stat(path)
	if err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	err = dir.Sync()
	closeErr := dir.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	ok = true
	cacheProjectionFingerprint(path, writtenInfo, renamedInfo, contentHash)
	return nil
}

func projectionUnchanged(path string, size int, contentHash [sha256.Size]byte) (bool, error) {
	clean := filepath.Clean(path)
	info, err := os.Stat(clean)
	if errors.Is(err, os.ErrNotExist) {
		forgetProjectionFingerprint(clean)
		return false, nil
	}
	if err != nil {
		return false, err
	}

	cached, ok := projectionFingerprints.get(clean)
	if ok && cached.matches(info) {
		return cached.hash == contentHash, nil
	}
	if info.Size() != int64(size) {
		return false, nil
	}

	f, err := os.Open(clean)
	if err != nil {
		return false, err
	}
	hasher := sha256.New()
	_, copyErr := io.Copy(hasher, f)
	closeErr := f.Close()
	if copyErr != nil {
		return false, copyErr
	}
	if closeErr != nil {
		return false, closeErr
	}
	after, err := os.Stat(clean)
	if err != nil {
		return false, err
	}
	if !sameFileSnapshot(info, after) {
		return false, nil
	}
	var diskHash [sha256.Size]byte
	copy(diskHash[:], hasher.Sum(nil))
	if changeStamp, ok := projectionChangeStamp(after); ok {
		projectionFingerprints.put(clean, projectionFingerprint{info: after, changeStamp: changeStamp, hash: diskHash})
	}
	return diskHash == contentHash, nil
}

func cacheProjectionFingerprint(path string, writtenInfo, renamedInfo os.FileInfo, contentHash [sha256.Size]byte) {
	info, err := os.Stat(path)
	if err != nil || !sameFileIdentity(writtenInfo, renamedInfo) || !sameProjectionVersion(renamedInfo, info) {
		forgetProjectionFingerprint(path)
		return
	}
	clean := filepath.Clean(path)
	changeStamp, ok := projectionChangeStamp(info)
	if !ok {
		forgetProjectionFingerprint(clean)
		return
	}
	projectionFingerprints.put(clean, projectionFingerprint{info: info, changeStamp: changeStamp, hash: contentHash})
}

func forgetProjectionFingerprint(path string) {
	projectionFingerprints.forget(filepath.Clean(path))
}

func (fingerprint projectionFingerprint) matches(info os.FileInfo) bool {
	if fingerprint.info == nil ||
		fingerprint.info.Size() != info.Size() ||
		!fingerprint.info.ModTime().Equal(info.ModTime()) ||
		!os.SameFile(fingerprint.info, info) {
		return false
	}
	changeStamp, ok := projectionChangeStamp(info)
	return ok && changeStamp == fingerprint.changeStamp
}

func sameProjectionVersion(before, after os.FileInfo) bool {
	if !sameFileSnapshot(before, after) {
		return false
	}
	beforeStamp, beforeOK := projectionChangeStamp(before)
	afterStamp, afterOK := projectionChangeStamp(after)
	return beforeOK && afterOK && beforeStamp == afterStamp
}

func sameFileIdentity(before, after os.FileInfo) bool {
	return before != nil &&
		after != nil &&
		before.Size() == after.Size() &&
		before.ModTime().Equal(after.ModTime()) &&
		os.SameFile(before, after)
}

func sameFileSnapshot(before, after os.FileInfo) bool {
	if !sameFileIdentity(before, after) {
		return false
	}
	beforeStamp, beforeOK := projectionChangeStamp(before)
	afterStamp, afterOK := projectionChangeStamp(after)
	return !beforeOK || !afterOK || beforeStamp == afterStamp
}

func projectionChangeStamp(info os.FileInfo) (string, bool) {
	if info == nil || info.Sys() == nil {
		return "", false
	}
	value := reflect.ValueOf(info.Sys())
	for value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return "", false
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return "", false
	}
	for _, name := range []string{"Ctimespec", "Ctim", "Ctime", "ChangeTime"} {
		field := value.FieldByName(name)
		if field.IsValid() && field.CanInterface() {
			return fmt.Sprint(field.Interface()), true
		}
	}
	return "", false
}

func (cache *fingerprintCache) get(path string) (projectionFingerprint, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	element := cache.entries[path]
	if element == nil {
		return projectionFingerprint{}, false
	}
	cache.order.MoveToFront(element)
	return element.Value.(fingerprintEntry).fingerprint, true
}

func (cache *fingerprintCache) put(path string, fingerprint projectionFingerprint) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.entries == nil {
		cache.entries = make(map[string]*list.Element)
	}
	if element := cache.entries[path]; element != nil {
		element.Value = fingerprintEntry{path: path, fingerprint: fingerprint}
		cache.order.MoveToFront(element)
		return
	}
	cache.entries[path] = cache.order.PushFront(fingerprintEntry{path: path, fingerprint: fingerprint})
	if cache.order.Len() <= maxProjectionFingerprints {
		return
	}
	oldest := cache.order.Back()
	entry := oldest.Value.(fingerprintEntry)
	delete(cache.entries, entry.path)
	cache.order.Remove(oldest)
}

func (cache *fingerprintCache) forget(path string) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if element := cache.entries[path]; element != nil {
		delete(cache.entries, path)
		cache.order.Remove(element)
	}
}

type keyedLocker struct {
	mu    sync.Mutex
	locks map[string]*keyedLock
}

type keyedLock struct {
	mu   sync.Mutex
	refs int
}

func (k *keyedLocker) lock(key string) func() {
	k.mu.Lock()
	if k.locks == nil {
		k.locks = map[string]*keyedLock{}
	}
	entry := k.locks[key]
	if entry == nil {
		entry = &keyedLock{}
		k.locks[key] = entry
	}
	entry.refs++
	k.mu.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		k.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(k.locks, key)
		}
		k.mu.Unlock()
	}
}
