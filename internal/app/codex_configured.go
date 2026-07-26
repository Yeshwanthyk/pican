package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"pican/internal/codex"
	"pican/internal/rpc"
	"pican/internal/runtimes"
	"pican/internal/server"
	"pican/internal/sessions"
	"pican/internal/workers"
)

func configuredCodexCatalog(sessionsDir string, command []string, process codex.ProcessOptions, resolveCWD func(string) (string, error)) func(context.Context) (runtimes.CatalogResult, error) {
	var options []codex.CatalogOption
	if resolveCWD != nil {
		options = append(options, codex.WithCatalogCWDResolver(resolveCWD))
	}
	catalog := codex.NewCatalogWithOptions(sessionsDir, command, process, options...)
	return func(ctx context.Context) (runtimes.CatalogResult, error) {
		result, err := catalog.Sync(ctx)
		return runtimes.CatalogResult{SessionIDs: result.IDs, Complete: err == nil}, err
	}
}

func configuredCodexWorkerFactory(runCtx context.Context, sessionsDir string, command []string, currentServer func() *server.Server, process codex.ProcessOptions) workers.Factory {
	return func(sessionID, sessionPath string) (workers.ChatWorker, error) {
		parsed, err := sessions.ParseFile(sessionPath, filepath.Base(filepath.Dir(sessionPath)), filepath.Base(sessionPath))
		if err != nil {
			return nil, fmt.Errorf("read session runtime: %w", err)
		}
		if _, err := codex.ReadProjectionMetadata(sessionPath); err != nil {
			return nil, err
		}
		workerCtx, cancel := context.WithTimeout(runCtx, 35*time.Second)
		defer cancel()
		return codex.NewWorkerWithOptions(workerCtx, sessionPath, command, codex.Callbacks{
			Preview: func(preview codex.Preview) {
				if srv := currentServer(); srv != nil {
					srv.BroadcastChatPreview(sessionID, rpc.StreamPreview{Content: preview.Text, Done: preview.Done, TurnID: preview.TurnID, ItemID: preview.ItemID})
				}
			},
			Status: func(workers.WorkerStatus) {
				if srv := currentServer(); srv != nil {
					srv.NotifyWorkerUpdate(sessionID, false)
				}
			},
			Projection: func(projection codex.Projection) {
				if srv := currentServer(); srv != nil {
					target := projection.ID
					if target == "" {
						target = sessionID
					}
					srv.NotifyWorkerUpdate(target, true)
				}
			},
			Lifecycle: func(action string, affectedID string) {
				if srv := currentServer(); srv != nil {
					target := affectedID
					if target == "" || target == parsed.NativeID {
						target = sessionID
					}
					srv.NotifyCodexLifecycle(action, target)
				}
			},
			Error: func(err error) {
				fmt.Fprintf(os.Stderr, "Codex worker failed for %s: %v\n", sessionID, err)
				if srv := currentServer(); srv != nil {
					srv.NotifyWorkerUpdate(sessionID, true)
				}
			},
		}, process)
	}
}

func configuredCodexModels(command []string, process codex.ProcessOptions) runtimeModelLoader {
	return func(ctx context.Context) ([]json.RawMessage, error) {
		discovered, err := codex.FetchModelsWithOptions(ctx, command, process)
		if err != nil {
			return nil, err
		}
		models := make([]json.RawMessage, 0, len(discovered))
		for _, model := range discovered {
			data, err := json.Marshal(model)
			if err != nil {
				return nil, err
			}
			models = append(models, data)
		}
		return models, nil
	}
}

type configuredCodexService struct {
	sessionsDir string
	command     []string
	process     codex.ProcessOptions
}

func (c configuredCodexService) StartSession(ctx context.Context, cwd, model, effort string) (codex.Projection, error) {
	return codex.StartSessionWithOptions(ctx, c.sessionsDir, c.command, cwd, model, effort, c.process)
}
func (c configuredCodexService) RenameSession(ctx context.Context, nativeID, name string) (codex.Projection, error) {
	return codex.RenameSessionWithOptions(ctx, c.sessionsDir, c.command, nativeID, name, c.process)
}
func (c configuredCodexService) ForkSession(ctx context.Context, nativeID string, turnID *string) (codex.Projection, error) {
	return codex.ForkSessionWithOptions(ctx, c.sessionsDir, c.command, nativeID, turnID, c.process)
}
func (c configuredCodexService) RefreshThread(ctx context.Context, nativeID string) (codex.Projection, error) {
	return codex.RefreshThreadWithOptions(ctx, c.sessionsDir, c.command, nativeID, c.process)
}
func (c configuredCodexService) ArchiveSession(ctx context.Context, nativeID string) error {
	return codex.ArchiveSessionWithOptions(ctx, c.sessionsDir, c.command, nativeID, c.process)
}
func (c configuredCodexService) InspectArchivedThread(ctx context.Context, nativeID string) (codex.Thread, error) {
	return codex.InspectArchivedThreadWithOptions(ctx, c.command, nativeID, c.process)
}
func (c configuredCodexService) UnarchiveSession(ctx context.Context, nativeID string) (codex.Projection, error) {
	return codex.UnarchiveSessionWithOptions(ctx, c.sessionsDir, c.command, nativeID, c.process)
}
func (c configuredCodexService) DeleteSession(ctx context.Context, nativeID string) error {
	return codex.DeleteSessionWithOptions(ctx, c.sessionsDir, c.command, nativeID, c.process)
}
func (c configuredCodexService) ResolveTurnID(path, entryID string) (string, error) {
	return codex.ResolveTurnID(path, entryID)
}
func (c configuredCodexService) LabelSessionEntry(path, entryID, label string, now func() time.Time) error {
	return codex.LabelSessionEntry(path, entryID, label, now)
}
func (c configuredCodexService) AutoTitleSession(path, name string, now func() time.Time) error {
	return codex.AutoTitleSession(path, name, now)
}
