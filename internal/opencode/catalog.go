package opencode

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"pican/internal/runtimes"
)

// ErrPartialCatalog means the authoritative list succeeded but one or more
// projections couldn't be refreshed. Callers may keep a healthy child
// available, but must never prune from this result.
var ErrPartialCatalog = errors.New("OpenCode catalog reconciliation is partial")

// NativeClient is the authoritative HTTP surface used by catalog and
// lifecycle operations. A provider is resolved per operation so a restarted
// supervisor can replace the underlying authenticated client.
type NativeClient interface {
	ListSessions(context.Context, string) ([]Session, error)
	GetSession(context.Context, string, string) (Session, error)
	CreateSession(context.Context, string, CreateSessionRequest) (Session, error)
	UpdateSession(context.Context, string, string, UpdateSessionRequest) (Session, error)
	DeleteSession(context.Context, string, string) (bool, error)
	ForkSession(context.Context, string, string, ForkSessionRequest) (Session, error)
	Messages(context.Context, string, string) ([]Message, error)
	Children(context.Context, string, string) ([]Session, error)
	Status(context.Context, string) (map[string]SessionStatus, error)
}

type ClientProvider func() (NativeClient, error)

func StaticClient(client *Client) ClientProvider {
	return func() (NativeClient, error) {
		if client == nil {
			return nil, errors.New("OpenCode client is unavailable")
		}
		return client, nil
	}
}

type Catalog struct {
	sessionsDir   string
	seedDirectory string
	client        ClientProvider
	mu            sync.Mutex
}

func NewCatalog(sessionsDir, seedDirectory string, client ClientProvider) (*Catalog, error) {
	if client == nil {
		return nil, errors.New("OpenCode catalog requires a client provider")
	}
	canonical, err := CanonicalDirectory(seedDirectory)
	if err != nil {
		return nil, err
	}
	absolute, err := filepath.Abs(sessionsDir)
	if err != nil {
		return nil, err
	}
	return &Catalog{sessionsDir: filepath.Clean(absolute), seedDirectory: canonical, client: client}, nil
}

// Sync reconciles native membership into replaceable projections. Pruning is
// permitted only when the initial list, every scoped hydration, and a
// confirming list all succeed with identical native identity and directories.
func (c *Catalog) Sync(ctx context.Context) (runtimes.CatalogResult, error) {
	client, err := c.client()
	if err != nil {
		return runtimes.CatalogResult{Complete: false}, err
	}
	return c.SyncWithClient(ctx, client)
}

// SyncWithClient reconciles through a specific authenticated generation. The
// supervisor uses this during recovery before publishing that generation
// through ClientProvider; callers outside recovery should use Sync.
func (c *Catalog) SyncWithClient(ctx context.Context, client NativeClient) (runtimes.CatalogResult, error) {
	if client == nil {
		return runtimes.CatalogResult{Complete: false}, errors.New("OpenCode client is unavailable")
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	initial, initialErr := FindProjections(c.sessionsDir)
	listed, err := client.ListSessions(ctx, c.seedDirectory)
	if err != nil {
		return runtimes.CatalogResult{Complete: false}, err
	}

	result := runtimes.CatalogResult{Complete: initialErr == nil}
	membership := make(map[string]string, len(listed))
	var operationalErrors []error
	for _, summary := range listed {
		if err := ctx.Err(); err != nil {
			return runtimes.CatalogResult{Complete: false}, err
		}
		if summary.ID == "" {
			result.Complete = false
			operationalErrors = append(operationalErrors, errors.New("OpenCode catalog returned a session without an id"))
			continue
		}
		directory, directoryErr := CanonicalDirectory(summary.Directory)
		if directoryErr != nil {
			result.Complete = false
			operationalErrors = append(operationalErrors, fmt.Errorf("validate OpenCode session %s directory: %w", summary.ID, directoryErr))
			continue
		}
		if previous, duplicate := membership[summary.ID]; duplicate {
			result.Complete = false
			operationalErrors = append(operationalErrors, fmt.Errorf("OpenCode catalog returned duplicate session %s", summary.ID))
			if previous != directory {
				operationalErrors = append(operationalErrors, fmt.Errorf("OpenCode session %s crossed directories %q and %q", summary.ID, previous, directory))
			}
			continue
		}
		membership[summary.ID] = directory
		projection, hydrateErr := hydrateSession(ctx, client, c.sessionsDir, summary.ID, directory)
		if hydrateErr != nil {
			result.Complete = false
			operationalErrors = append(operationalErrors, fmt.Errorf("hydrate OpenCode session %s: %w", summary.ID, hydrateErr))
			continue
		}
		result.SessionIDs = append(result.SessionIDs, projection.ID)
	}
	sort.Strings(result.SessionIDs)

	if result.Complete {
		confirmed, confirmErr := client.ListSessions(ctx, c.seedDirectory)
		if confirmErr != nil {
			result.Complete = false
			operationalErrors = append(operationalErrors, fmt.Errorf("confirm OpenCode catalog membership: %w", confirmErr))
		} else {
			confirmedMembership, membershipErr := catalogMembership(confirmed)
			if membershipErr != nil {
				result.Complete = false
				operationalErrors = append(operationalErrors, membershipErr)
			} else if !equalMembership(membership, confirmedMembership) {
				result.Complete = false
				operationalErrors = append(operationalErrors, errors.New("OpenCode catalog membership changed during reconciliation"))
			}
		}
	}
	if result.Complete {
		for nativeID, path := range initial {
			if _, exists := membership[nativeID]; exists {
				continue
			}
			if removeErr := RemoveProjection(c.sessionsDir, path, nativeID); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				result.Complete = false
				operationalErrors = append(operationalErrors, fmt.Errorf("remove stale OpenCode projection %s: %w", nativeID, removeErr))
			}
		}
	}
	if initialErr != nil {
		operationalErrors = append(operationalErrors, fmt.Errorf("scan OpenCode projections: %w", initialErr))
	}
	if partialErr := errors.Join(operationalErrors...); partialErr != nil {
		return result, fmt.Errorf("%w: %w", ErrPartialCatalog, partialErr)
	}
	return result, nil
}

func (c *Catalog) RefreshSession(ctx context.Context, nativeID, directory string) (Projection, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	client, err := c.client()
	if err != nil {
		return Projection{}, err
	}
	return hydrateSession(ctx, client, c.sessionsDir, nativeID, directory)
}

func (c *Catalog) NativeExists(ctx context.Context, nativeID, directory string) bool {
	client, err := c.client()
	if err != nil {
		return false
	}
	native, err := client.GetSession(ctx, nativeID, directory)
	if err != nil {
		return false
	}
	return validateSessionIdentity(native, nativeID, directory) == nil
}

func hydrateSession(ctx context.Context, client NativeClient, sessionsDir, nativeID, directory string) (Projection, error) {
	native, err := client.GetSession(ctx, nativeID, directory)
	if err != nil {
		return Projection{}, err
	}
	if err := validateSessionIdentity(native, nativeID, directory); err != nil {
		return Projection{}, err
	}
	messages, err := client.Messages(ctx, nativeID, directory)
	if err != nil {
		return Projection{}, err
	}
	for index := range messages {
		if messages[index].Info.ID == "" {
			return Projection{}, fmt.Errorf("OpenCode session %s message %d has no id", nativeID, index)
		}
		if messages[index].Info.SessionID != nativeID {
			return Projection{}, fmt.Errorf("OpenCode session %s received foreign message for %s", nativeID, messages[index].Info.SessionID)
		}
		for partIndex := range messages[index].Parts {
			part := messages[index].Parts[partIndex]
			if part.SessionID != "" && part.SessionID != nativeID {
				return Projection{}, fmt.Errorf("OpenCode session %s received foreign part for %s", nativeID, part.SessionID)
			}
			if part.MessageID != "" && part.MessageID != messages[index].Info.ID {
				return Projection{}, fmt.Errorf("OpenCode message %s received foreign part for %s", messages[index].Info.ID, part.MessageID)
			}
		}
	}
	return Materialize(sessionsDir, native, messages)
}

func validateSessionIdentity(native Session, nativeID, directory string) error {
	if nativeID == "" || native.ID != nativeID {
		return fmt.Errorf("OpenCode session identity mismatch: requested %q, received %q", nativeID, native.ID)
	}
	_, err := validateScopedDirectory(directory, native.Directory)
	return err
}

func catalogMembership(sessions []Session) (map[string]string, error) {
	out := make(map[string]string, len(sessions))
	for _, native := range sessions {
		if native.ID == "" {
			return nil, errors.New("OpenCode catalog returned a session without an id")
		}
		directory, err := CanonicalDirectory(native.Directory)
		if err != nil {
			return nil, fmt.Errorf("validate OpenCode session %s directory: %w", native.ID, err)
		}
		if _, duplicate := out[native.ID]; duplicate {
			return nil, fmt.Errorf("OpenCode catalog returned duplicate session %s", native.ID)
		}
		out[native.ID] = directory
	}
	return out, nil
}

func equalMembership(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for id, directory := range left {
		if right[id] != directory {
			return false
		}
	}
	return true
}
