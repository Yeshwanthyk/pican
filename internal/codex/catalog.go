package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

type SyncResult struct {
	IDs    []string          `json:"ids"`
	Errors map[string]string `json:"errors,omitempty"`
}

// Sync imports every visible, non-archived Codex thread. A successful complete
// list is authoritative for membership: validated Codex projections absent
// from it are pruned. Pi files and projections after a list failure are never
// removed.
func Sync(ctx context.Context, sessionsDir string, command []string) (SyncResult, error) {
	// Membership pruning applies only to projections that existed before this
	// list began. A thread created concurrently may not appear in the list's
	// snapshot and must not have its newly materialized projection removed.
	initialProjections, initialScanErr := FindProjections(sessionsDir)

	c, err := NewClient(ctx, command, nil)
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
		listedIDs[listed.ID] = struct{}{}
		thread, readErr := c.ReadThread(ctx, listed.ID)
		if readErr != nil {
			result.Errors[listed.ID] = readErr.Error()
			continue
		}
		projection, writeErr := Materialize(sessionsDir, thread)
		if writeErr != nil {
			result.Errors[listed.ID] = writeErr.Error()
			continue
		}
		result.IDs = append(result.IDs, projection.ID)
	}
	if initialScanErr != nil {
		result.Errors["projection-scan"] = initialScanErr.Error()
	} else {
		for nativeID, path := range initialProjections {
			if _, visible := listedIDs[nativeID]; visible {
				continue
			}
			if removeErr := RemoveProjection(path, nativeID); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				result.Errors[nativeID] = removeErr.Error()
			}
		}
	}
	if len(result.Errors) == 0 {
		result.Errors = nil
	}
	return result, nil
}

// FetchModels uses a short-lived app-server client for model discovery.
func FetchModels(ctx context.Context, command []string) ([]PicanModel, error) {
	client, err := NewClient(ctx, command, nil)
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

func withClient(ctx context.Context, command []string, fn func(*Client) (Thread, error)) (Thread, error) {
	c, err := NewClient(ctx, command, nil)
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
	thread, err := withClient(ctx, command, func(c *Client) (Thread, error) { return c.ReadThread(ctx, nativeID) })
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
	thread, err := withClient(ctx, command, func(c *Client) (Thread, error) {
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
	return Materialize(sessionsDir, thread)
}

// RenameSession changes the Codex thread name, then refreshes the projection.
func RenameSession(ctx context.Context, sessionsDir string, command []string, nativeID, name string) (Projection, error) {
	thread, err := withClient(ctx, command, func(c *Client) (Thread, error) {
		if err := c.SetThreadName(ctx, nativeID, name); err != nil {
			return Thread{}, err
		}
		return c.ReadThread(ctx, nativeID)
	})
	if err != nil {
		return Projection{}, err
	}
	thread.Name = name
	return Materialize(sessionsDir, thread)
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
	if _, err := withClient(ctx, command, func(c *Client) (Thread, error) {
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
	if _, err := withClient(ctx, command, func(c *Client) (Thread, error) {
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
	thread, err := withClient(ctx, command, func(c *Client) (Thread, error) {
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
	if nativeID == "" {
		return Projection{}, errors.New("native thread id required")
	}
	thread, err := withClient(ctx, command, func(c *Client) (Thread, error) {
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
