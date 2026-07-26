package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type SyncResult struct {
	IDs    []string          `json:"ids"`
	Errors map[string]string `json:"errors,omitempty"`
}

type Catalog struct {
	sessionsDir string
	command     []string
	process     ProcessOptions
	resolveCWD  func(string) (string, error)

	mu        sync.Mutex
	updatedAt map[string]int64
}

type CatalogOption func(*Catalog)

// WithCatalogCWDResolver limits materialization to threads whose authoritative
// working directory is accepted by resolve.
func WithCatalogCWDResolver(resolve func(string) (string, error)) CatalogOption {
	return func(catalog *Catalog) {
		catalog.resolveCWD = resolve
	}
}

func NewCatalog(sessionsDir string, command []string) *Catalog {
	return NewCatalogWithOptions(sessionsDir, command, ProcessOptions{})
}

func NewCatalogWithOptions(sessionsDir string, command []string, options ProcessOptions, catalogOptions ...CatalogOption) *Catalog {
	catalog := &Catalog{
		sessionsDir: sessionsDir,
		command:     append([]string(nil), command...),
		process:     options.clone(),
		updatedAt:   make(map[string]int64),
	}
	for _, option := range catalogOptions {
		option(catalog)
	}
	return catalog
}

// Sync imports every visible, non-archived Codex thread. A successful complete
// list is authoritative for membership: validated Codex projections absent
// from it are pruned. Pi files and projections after a list failure are never
// removed.
func Sync(ctx context.Context, sessionsDir string, command []string) (SyncResult, error) {
	return NewCatalog(sessionsDir, command).Sync(ctx)
}

func SyncWithOptions(ctx context.Context, sessionsDir string, command []string, options ProcessOptions) (SyncResult, error) {
	return NewCatalogWithOptions(sessionsDir, command, options).Sync(ctx)
}

func (catalog *Catalog) Sync(ctx context.Context) (SyncResult, error) {
	catalog.mu.Lock()
	defer catalog.mu.Unlock()

	// Membership pruning applies only to projections that existed before this
	// list began. A thread created concurrently may not appear in the list's
	// snapshot and must not have its newly materialized projection removed.
	initialProjections, initialScanErr := FindProjections(catalog.sessionsDir)

	c, err := NewClientWithOptions(ctx, catalog.command, nil, catalog.process)
	if err != nil {
		return SyncResult{}, err
	}
	defer c.Close()
	threads, err := c.ListThreads(ctx, ThreadListOptions{Archived: false, UseStateDBOnly: false})
	if err != nil {
		return SyncResult{}, err
	}
	result := SyncResult{Errors: map[string]string{}}
	listedIDs := make(map[string]struct{}, len(threads))
	for _, listed := range threads {
		// Hosted catalogs must validate the authoritative thread record before
		// treating it as visible. Always read in that mode, even when a cached
		// projection has the same timestamp, so a stale outside projection
		// can't survive on metadata alone.
		_, projected := initialProjections[listed.ID]
		if catalog.resolveCWD == nil {
			listedIDs[listed.ID] = struct{}{}
		}
		if catalog.resolveCWD == nil {
			if updatedAt, exists := catalog.updatedAt[listed.ID]; initialScanErr == nil && projected && exists && updatedAt == listed.UpdatedAt {
				metadata, metadataErr := ReadProjectionMetadata(initialProjections[listed.ID])
				if metadataErr == nil && !metadata.Fresh {
					result.IDs = append(result.IDs, filepath.Base(initialProjections[listed.ID]))
					continue
				}
			}
		}
		thread, readErr := c.ReadThread(ctx, listed.ID)
		if readErr != nil {
			result.Errors[listed.ID] = readErr.Error()
			continue
		}
		if catalog.resolveCWD != nil {
			canonicalCWD, resolveErr := catalog.resolveCWD(thread.CWD)
			if resolveErr != nil {
				delete(catalog.updatedAt, listed.ID)
				continue
			}
			thread.CWD = canonicalCWD
			listedIDs[listed.ID] = struct{}{}
		}
		projection, writeErr := materializeProjection(catalog.sessionsDir, thread, clearFreshProjection)
		if writeErr != nil {
			result.Errors[listed.ID] = writeErr.Error()
			continue
		}
		catalog.updatedAt[listed.ID] = listed.UpdatedAt
		result.IDs = append(result.IDs, projection.ID)
	}
	if initialScanErr != nil {
		result.Errors["projection-scan"] = initialScanErr.Error()
	} else {
		for nativeID, path := range initialProjections {
			if _, visible := listedIDs[nativeID]; visible {
				continue
			}
			metadata, metadataErr := ReadProjectionMetadata(path)
			if metadataErr != nil {
				result.Errors[nativeID] = metadataErr.Error()
				continue
			}
			// A newly created empty thread can lag thread/list even after
			// thread/name/set and thread/read succeeded. Its durable projection
			// marker is creation intent and survives complete stale listings
			// until activity or authoritative list visibility clears it.
			if metadata.Fresh {
				continue
			}
			if removeErr := RemoveProjection(path, nativeID); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				result.Errors[nativeID] = removeErr.Error()
			}
		}
	}
	for nativeID := range catalog.updatedAt {
		if _, visible := listedIDs[nativeID]; !visible {
			delete(catalog.updatedAt, nativeID)
		}
	}
	if len(result.Errors) == 0 {
		result.Errors = nil
	}
	return result, nil
}

// FetchModels uses a short-lived app-server client for model discovery.
func FetchModels(ctx context.Context, command []string) ([]PicanModel, error) {
	return FetchModelsWithOptions(ctx, command, ProcessOptions{})
}

func FetchModelsWithOptions(ctx context.Context, command []string, options ProcessOptions) ([]PicanModel, error) {
	client, err := NewClientWithOptions(ctx, command, nil, options)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	models, err := client.ListModels(ctx, false)
	if err != nil {
		return nil, err
	}
	return MapModels(models), nil
}

func withClient(ctx context.Context, command []string, options ProcessOptions, fn func(*Client) (Thread, error)) (Thread, error) {
	c, err := NewClientWithOptions(ctx, command, nil, options)
	if err != nil {
		return Thread{}, err
	}
	defer c.Close()
	return fn(c)
}

func applyOpenMetadata(thread *Thread, opened Thread) {
	thread.Model = opened.Model
	thread.ModelProvider = opened.ModelProvider
	thread.Effort = opened.Effort
	thread.ApprovalPolicy = append(json.RawMessage(nil), opened.ApprovalPolicy...)
	thread.Sandbox = append(json.RawMessage(nil), opened.Sandbox...)
}

// RefreshThread reads the authoritative thread and rewrites its projection.
func RefreshThread(ctx context.Context, sessionsDir string, command []string, nativeID string) (Projection, error) {
	return RefreshThreadWithOptions(ctx, sessionsDir, command, nativeID, ProcessOptions{})
}

func RefreshThreadWithOptions(ctx context.Context, sessionsDir string, command []string, nativeID string, options ProcessOptions) (Projection, error) {
	thread, err := withClient(ctx, command, options, func(c *Client) (Thread, error) { return c.ReadThread(ctx, nativeID) })
	if err != nil {
		return Projection{}, err
	}
	return Materialize(sessionsDir, thread)
}

const newSessionName = "New Codex session"

// StartSession starts a persistent Codex thread and materializes it. Codex
// does not make an empty thread resumable until it has either a user message
// or persisted metadata, so setting the initial name is part of creation — it
// prevents the short-lived creation app-server from losing the empty thread.
func StartSession(ctx context.Context, sessionsDir string, command []string, cwd, model, effort string) (Projection, error) {
	return StartSessionWithOptions(ctx, sessionsDir, command, cwd, model, effort, ProcessOptions{})
}

func StartSessionWithOptions(ctx context.Context, sessionsDir string, command []string, cwd, model, effort string, options ProcessOptions) (Projection, error) {
	thread, err := withClient(ctx, command, options, func(c *Client) (Thread, error) {
		t, err := c.StartThread(ctx, cwd, model, effort)
		if err != nil {
			return Thread{}, err
		}
		if err := c.SetThreadName(ctx, t.ID, newSessionName); err != nil {
			return Thread{}, fmt.Errorf("persist empty Codex thread: %w", err)
		}
		full, err := c.ReadThread(ctx, t.ID)
		if err != nil {
			return Thread{}, err
		}
		applyOpenMetadata(&full, t)
		return full, nil
	})
	if err != nil {
		return Projection{}, err
	}
	return materializeProjection(sessionsDir, thread, setFreshProjection)
}

// RenameSession changes the Codex thread name, then refreshes the projection.
func RenameSession(ctx context.Context, sessionsDir string, command []string, nativeID, name string) (Projection, error) {
	return RenameSessionWithOptions(ctx, sessionsDir, command, nativeID, name, ProcessOptions{})
}

func RenameSessionWithOptions(ctx context.Context, sessionsDir string, command []string, nativeID, name string, options ProcessOptions) (Projection, error) {
	thread, err := withClient(ctx, command, options, func(c *Client) (Thread, error) {
		if err := c.SetThreadName(ctx, nativeID, name); err != nil {
			return Thread{}, err
		}
		return c.ReadThread(ctx, nativeID)
	})
	if err != nil {
		return Projection{}, err
	}
	thread.Name = name
	projection, err := Materialize(sessionsDir, thread)
	if err != nil {
		return Projection{}, err
	}
	// Materialize preserves pican-local session_info entries. Append a manual
	// marker after refreshing so an older auto-title cannot keep precedence over
	// the native name, and future auto-title passes recognize user ownership.
	if err := RenameProjection(projection.Path, name, nil); err != nil {
		return Projection{}, fmt.Errorf("persist manual Codex session name: %w", err)
	}
	return projection, nil
}

func projectionForNativeID(sessionsDir, nativeID string) (string, error) {
	projections, err := FindProjections(sessionsDir)
	if err != nil {
		return "", err
	}
	path := projections[nativeID]
	if path == "" {
		return "", os.ErrNotExist
	}
	return path, nil
}

func ArchiveSession(ctx context.Context, sessionsDir string, command []string, nativeID string) error {
	return ArchiveSessionWithOptions(ctx, sessionsDir, command, nativeID, ProcessOptions{})
}

func ArchiveSessionWithOptions(ctx context.Context, sessionsDir string, command []string, nativeID string, options ProcessOptions) error {
	if _, err := withClient(ctx, command, options, func(c *Client) (Thread, error) {
		return Thread{}, c.ArchiveThread(ctx, nativeID)
	}); err != nil {
		return err
	}
	path, err := projectionForNativeID(sessionsDir, nativeID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := RemoveProjection(path, nativeID); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func DeleteSession(ctx context.Context, sessionsDir string, command []string, nativeID string) error {
	return DeleteSessionWithOptions(ctx, sessionsDir, command, nativeID, ProcessOptions{})
}

func DeleteSessionWithOptions(ctx context.Context, sessionsDir string, command []string, nativeID string, options ProcessOptions) error {
	if _, err := withClient(ctx, command, options, func(c *Client) (Thread, error) {
		return Thread{}, c.DeleteThread(ctx, nativeID)
	}); err != nil {
		return err
	}
	path, err := projectionForNativeID(sessionsDir, nativeID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := RemoveProjection(path, nativeID); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func UnarchiveSession(ctx context.Context, sessionsDir string, command []string, nativeID string) (Projection, error) {
	return UnarchiveSessionWithOptions(ctx, sessionsDir, command, nativeID, ProcessOptions{})
}

func InspectArchivedThread(ctx context.Context, command []string, nativeID string) (Thread, error) {
	return InspectArchivedThreadWithOptions(ctx, command, nativeID, ProcessOptions{})
}

// InspectArchivedThread returns authoritative archived metadata without
// mutating the thread. Hosted callers use it for authorization before
// thread/unarchive.
func InspectArchivedThreadWithOptions(ctx context.Context, command []string, nativeID string, options ProcessOptions) (Thread, error) {
	return withClient(ctx, command, options, func(c *Client) (Thread, error) {
		archived, err := c.ListThreads(ctx, ThreadListOptions{Archived: true, UseStateDBOnly: false})
		if err != nil {
			return Thread{}, err
		}
		for _, candidate := range archived {
			if candidate.ID == nativeID {
				return candidate, nil
			}
		}
		return Thread{}, os.ErrNotExist
	})
}

func UnarchiveSessionWithOptions(ctx context.Context, sessionsDir string, command []string, nativeID string, options ProcessOptions) (Projection, error) {
	thread, err := withClient(ctx, command, options, func(c *Client) (Thread, error) {
		archived, err := c.ListThreads(ctx, ThreadListOptions{Archived: true, UseStateDBOnly: false})
		if err != nil {
			return Thread{}, err
		}
		found := false
		for _, candidate := range archived {
			if candidate.ID == nativeID {
				found = true
				break
			}
		}
		if !found {
			return Thread{}, os.ErrNotExist
		}
		if err := c.UnarchiveThread(ctx, nativeID); err != nil {
			return Thread{}, err
		}
		return c.ReadThread(ctx, nativeID)
	})
	if err != nil {
		return Projection{}, err
	}
	return Materialize(sessionsDir, thread)
}

// ForkSession forks at the optional native turn ID and materializes the fork.
func ForkSession(ctx context.Context, sessionsDir string, command []string, nativeID string, lastTurnID *string) (Projection, error) {
	return ForkSessionWithOptions(ctx, sessionsDir, command, nativeID, lastTurnID, ProcessOptions{})
}

func ForkSessionWithOptions(ctx context.Context, sessionsDir string, command []string, nativeID string, lastTurnID *string, options ProcessOptions) (Projection, error) {
	if nativeID == "" {
		return Projection{}, errors.New("native thread id required")
	}
	thread, err := withClient(ctx, command, options, func(c *Client) (Thread, error) {
		t, err := c.ForkThread(ctx, nativeID, lastTurnID)
		if err != nil {
			return Thread{}, err
		}
		full, err := c.ReadThread(ctx, t.ID)
		if err != nil {
			return Thread{}, err
		}
		applyOpenMetadata(&full, t)
		return full, nil
	})
	if err != nil {
		return Projection{}, err
	}
	return Materialize(sessionsDir, thread)
}
