package opencode

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pican/internal/projections"
)

const newSessionTitle = "New OpenCode session"

// Service exposes only lifecycle operations proven by OpenCode's supported
// HTTP API. Archive/unarchive and transcript-copy emulation are intentionally
// absent.
type Service struct {
	sessionsDir string
	client      ClientProvider
	catalog     *Catalog
}

func NewService(sessionsDir, seedDirectory string, client ClientProvider) (*Service, error) {
	catalog, err := NewCatalog(sessionsDir, seedDirectory, client)
	if err != nil {
		return nil, err
	}
	return &Service{sessionsDir: catalog.sessionsDir, client: client, catalog: catalog}, nil
}

func (s *Service) Catalog() *Catalog {
	return s.catalog
}

func (s *Service) StartSession(ctx context.Context, cwd, model string) (Projection, error) {
	directory, err := CanonicalDirectory(cwd)
	if err != nil {
		return Projection{}, err
	}
	if model != "" {
		if _, _, err := ParseModelID(model); err != nil {
			return Projection{}, err
		}
	}
	client, err := s.client()
	if err != nil {
		return Projection{}, err
	}
	native, err := client.CreateSession(ctx, directory, CreateSessionRequest{Title: newSessionTitle})
	if err != nil {
		return Projection{}, err
	}
	if err := validateSessionIdentity(native, native.ID, directory); err != nil {
		return Projection{}, err
	}
	projection, err := hydrateSession(ctx, client, s.sessionsDir, native.ID, directory)
	if err != nil {
		return Projection{}, err
	}
	if model != "" {
		if err := SetProjectionModel(projection.Path, model, nil); err != nil {
			return Projection{}, fmt.Errorf("persist OpenCode model selection: %w", err)
		}
	}
	return projection, nil
}

func (s *Service) RefreshSession(ctx context.Context, nativeID, cwd string) (Projection, error) {
	directory, err := CanonicalDirectory(cwd)
	if err != nil {
		return Projection{}, err
	}
	client, err := s.client()
	if err != nil {
		return Projection{}, err
	}
	return hydrateSession(ctx, client, s.sessionsDir, nativeID, directory)
}

func (s *Service) RenameSession(ctx context.Context, nativeID, cwd, title string) (Projection, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return Projection{}, errors.New("OpenCode session title is required")
	}
	directory, client, err := s.validatedClient(ctx, nativeID, cwd)
	if err != nil {
		return Projection{}, err
	}
	native, err := client.UpdateSession(ctx, nativeID, directory, UpdateSessionRequest{Title: title})
	if err != nil {
		return Projection{}, err
	}
	if err := validateSessionIdentity(native, nativeID, directory); err != nil {
		return Projection{}, err
	}
	projection, err := hydrateSession(ctx, client, s.sessionsDir, nativeID, directory)
	if err != nil {
		return Projection{}, err
	}
	if err := RenameProjection(projection.Path, title, nil); err != nil {
		return Projection{}, fmt.Errorf("persist manual OpenCode session name: %w", err)
	}
	return projection, nil
}

// ForkSession creates a native OpenCode fork at a native message boundary.
func (s *Service) ForkSession(ctx context.Context, nativeID, cwd, messageID string) (Projection, error) {
	directory, client, err := s.validatedClient(ctx, nativeID, cwd)
	if err != nil {
		return Projection{}, err
	}
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return Projection{}, errors.New("OpenCode fork message id is required")
	}
	request := ForkSessionRequest{MessageID: messageID}
	native, err := client.ForkSession(ctx, nativeID, directory, request)
	if err != nil {
		return Projection{}, err
	}
	if native.ID == "" || native.ID == nativeID {
		return Projection{}, errors.New("OpenCode fork returned an invalid native session id")
	}
	if err := validateSessionIdentity(native, native.ID, directory); err != nil {
		return Projection{}, err
	}
	return hydrateSession(ctx, client, s.sessionsDir, native.ID, directory)
}

func (s *Service) CloneSession(ctx context.Context, nativeID, cwd string) (Projection, error) {
	directory, client, err := s.validatedClient(ctx, nativeID, cwd)
	if err != nil {
		return Projection{}, err
	}
	native, err := client.ForkSession(ctx, nativeID, directory, ForkSessionRequest{})
	if err != nil {
		return Projection{}, err
	}
	if native.ID == "" || native.ID == nativeID {
		return Projection{}, errors.New("OpenCode clone returned an invalid native session id")
	}
	if err := validateSessionIdentity(native, native.ID, directory); err != nil {
		return Projection{}, err
	}
	return hydrateSession(ctx, client, s.sessionsDir, native.ID, directory)
}

func (s *Service) DeleteSession(ctx context.Context, nativeID, cwd string) error {
	directory, client, err := s.validatedClient(ctx, nativeID, cwd)
	if err != nil {
		return err
	}
	deleted, err := client.DeleteSession(ctx, nativeID, directory)
	if err != nil {
		return err
	}
	if !deleted {
		return errors.New("OpenCode did not confirm session deletion")
	}
	projectionPaths, err := FindProjections(s.sessionsDir)
	if err != nil {
		return err
	}
	path := projectionPaths[nativeID]
	if path == "" {
		return nil
	}
	metadata, err := ReadProjectionMetadata(path)
	if err != nil {
		return err
	}
	if _, err := validateScopedDirectory(directory, metadata.CWD); err != nil {
		return err
	}
	if err := RemoveProjection(s.sessionsDir, path, nativeID); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *Service) Children(ctx context.Context, nativeID, cwd string) ([]Session, error) {
	directory, client, err := s.validatedClient(ctx, nativeID, cwd)
	if err != nil {
		return nil, err
	}
	children, err := client.Children(ctx, nativeID, directory)
	if err != nil {
		return nil, err
	}
	for _, child := range children {
		if child.ID == "" {
			return nil, errors.New("OpenCode returned a child session without an id")
		}
		if child.ParentID != "" && child.ParentID != nativeID {
			return nil, fmt.Errorf("OpenCode session %s returned foreign child %s", nativeID, child.ID)
		}
		if err := validateSessionIdentity(child, child.ID, directory); err != nil {
			return nil, err
		}
	}
	return children, nil
}

func (s *Service) Status(ctx context.Context, cwd string) (map[string]SessionStatus, error) {
	directory, err := CanonicalDirectory(cwd)
	if err != nil {
		return nil, err
	}
	client, err := s.client()
	if err != nil {
		return nil, err
	}
	return client.Status(ctx, directory)
}

func (s *Service) NativeExists(ctx context.Context, nativeID, cwd string) bool {
	directory, client, err := s.validatedClient(ctx, nativeID, cwd)
	return err == nil && directory != "" && client != nil
}

func (s *Service) ResolveMessageID(path, entryID string) (string, error) {
	return ResolveMessageID(path, entryID)
}

func (s *Service) LabelSessionEntry(path, entryID, label string, now func() time.Time) error {
	return LabelSessionEntry(path, entryID, label, now)
}

func (s *Service) AutoTitleSession(path, name string, now func() time.Time) error {
	return AutoTitleSession(path, name, now)
}

func (s *Service) validatedClient(ctx context.Context, nativeID, cwd string) (string, NativeClient, error) {
	directory, err := CanonicalDirectory(cwd)
	if err != nil {
		return "", nil, err
	}
	if strings.TrimSpace(nativeID) == "" {
		return "", nil, errors.New("OpenCode native session id is required")
	}
	client, err := s.client()
	if err != nil {
		return "", nil, err
	}
	native, err := client.GetSession(ctx, nativeID, directory)
	if err != nil {
		return "", nil, err
	}
	if err := validateSessionIdentity(native, nativeID, directory); err != nil {
		return "", nil, err
	}
	return directory, client, nil
}

func projectionStoreForPath(path string) (*projections.Store, error) {
	return projections.NewStore(filepath.Dir(filepath.Dir(path)), RuntimeID)
}

// SetProjectionModel records a pican-owned model selection. The worker applies
// it to future prompts; native messages remain authoritative for actual use.
func SetProjectionModel(path, model string, now func() time.Time) error {
	if _, _, err := ParseModelID(model); err != nil {
		return err
	}
	if _, err := ReadProjectionMetadata(path); err != nil {
		return err
	}
	if now == nil {
		now = time.Now
	}
	timestamp := now().UTC()
	store, err := projectionStoreForPath(path)
	if err != nil {
		return err
	}
	return store.AppendLocal(path, map[string]any{
		"type":      "model_change",
		"id":        fmt.Sprintf("model-%d", timestamp.UnixNano()),
		"timestamp": timestamp.Format(time.RFC3339Nano),
		"provider":  Provider,
		"modelId":   model,
	})
}
