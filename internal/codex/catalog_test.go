package codex

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pican/internal/sessions"
	"pican/internal/workspace"
)

func TestSyncPrunesOnlyValidatedCodexProjectionAfterSuccessfulList(t *testing.T) {
	root := t.TempDir()
	codexProjection, err := Materialize(root, Thread{ID: "stale", CWD: "/tmp/stale", CreatedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	piDir := filepath.Join(root, sessions.EncodeProjectName("/tmp/pi"))
	if err = os.MkdirAll(piDir, 0755); err != nil {
		t.Fatal(err)
	}
	piPath := filepath.Join(piDir, "pi.jsonl")
	if err = os.WriteFile(piPath, []byte(`{"type":"session","id":"pi","cwd":"/tmp/pi"}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = Sync(context.Background(), root, helperCommand("list-failure")); err == nil {
		t.Fatal("expected list failure")
	}
	if _, err = os.Stat(codexProjection.Path); err != nil {
		t.Fatalf("pruned after failed list: %v", err)
	}
	if _, err = Sync(context.Background(), root, helperCommand("empty-list")); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(codexProjection.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale projection remains: %v", err)
	}
	if _, err = os.Stat(piPath); err != nil {
		t.Fatalf("Pi file pruned: %v", err)
	}
}

func TestSyncPrunesRecentProjectionMissingFromAuthoritativeList(t *testing.T) {
	root := t.TempDir()
	projection, err := Materialize(root, Thread{ID: "recent", CWD: t.TempDir(), CreatedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(context.Background(), root, helperCommand("empty-list")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(projection.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("recent projection remains after authoritative list: %v", err)
	}
}

func TestCatalogRetainsFreshEmptySessionUntilListVisibility(t *testing.T) {
	root := t.TempDir()
	projection, err := StartSession(
		context.Background(),
		root,
		helperCommand("created-empty"),
		"/tmp/project",
		"gpt",
		"medium",
	)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := ReadProjectionMetadata(projection.Path)
	if err != nil || !metadata.Fresh {
		t.Fatalf("new empty session = metadata:%+v err:%v, want durable fresh intent", metadata, err)
	}

	catalog := NewCatalog(root, helperCommand("empty-list"))
	if _, err := catalog.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	metadata, err = ReadProjectionMetadata(projection.Path)
	if err != nil || !metadata.Fresh {
		t.Fatalf("stale complete list pruned fresh session: metadata=%+v err=%v", metadata, err)
	}

	catalog.command = helperCommand("list-empty-thread")
	if _, err := catalog.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	metadata, err = ReadProjectionMetadata(projection.Path)
	if err != nil || metadata.Fresh {
		t.Fatalf("authoritative list visibility did not clear fresh intent: metadata=%+v err=%v", metadata, err)
	}

	catalog.command = helperCommand("empty-list")
	if _, err := catalog.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(projection.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("projection remains after fresh intent cleared and membership disappeared: %v", err)
	}
}

func TestCatalogSkipsUnchangedThreadAndReadsUpdatedThread(t *testing.T) {
	root := t.TempDir()
	logPath := filepath.Join(t.TempDir(), "rpc.log")
	catalog := NewCatalog(root, helperCommand("normal", logPath))

	first, err := catalog.Sync(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	projections, err := FindProjections(root)
	if err != nil {
		t.Fatal(err)
	}
	wantID := filepath.Base(projections["thread-1"])
	if len(first.IDs) != 1 || first.IDs[0] != wantID {
		t.Fatalf("initial IDs = %v, want [%s]", first.IDs, wantID)
	}
	second, err := catalog.Sync(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(second.IDs) != 1 || second.IDs[0] != wantID {
		t.Fatalf("unchanged IDs = %v, want [%s]", second.IDs, wantID)
	}
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(data), "thread/list\n"); got != 2 {
		t.Fatalf("thread/list calls = %d, want 2", got)
	}
	if got := strings.Count(string(data), "thread/read\n"); got != 1 {
		t.Fatalf("thread/read calls = %d, want 1 for unchanged UpdatedAt", got)
	}

	if err := os.Remove(projections["thread-1"]); err != nil {
		t.Fatal(err)
	}
	rehydrated, err := catalog.Sync(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rehydrated.IDs) != 1 || rehydrated.IDs[0] != wantID {
		t.Fatalf("rehydrated IDs = %v, want [%s]", rehydrated.IDs, wantID)
	}
	data, err = os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(data), "thread/read\n"); got != 2 {
		t.Fatalf("thread/read calls after projection deletion = %d, want 2", got)
	}

	catalog.updatedAt["thread-1"]--
	if _, err := catalog.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(data), "thread/read\n"); got != 3 {
		t.Fatalf("thread/read calls after UpdatedAt change = %d, want 3", got)
	}
}

func TestHostedCatalogDoesNotProjectOutsideWorkspaceThreads(t *testing.T) {
	sessionsRoot := t.TempDir()
	root := t.TempDir()
	workspaceRoot := filepath.Join(root, "workspace")
	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(workspaceRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	resolver, err := workspace.New(workspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	escape := filepath.Join(workspaceRoot, "escape")
	if err := os.Symlink(outside, escape); err != nil {
		t.Fatal(err)
	}

	for _, candidate := range []string{outside, escape} {
		t.Run(filepath.Base(candidate), func(t *testing.T) {
			projection, err := Materialize(sessionsRoot, Thread{ID: "thread-1", CWD: candidate, CreatedAt: 1})
			if err != nil {
				t.Fatal(err)
			}
			t.Setenv("PICAN_TEST_THREAD_CWD", candidate)
			catalog := NewCatalogWithOptions(
				sessionsRoot,
				helperCommand("catalog-cwd"),
				ProcessOptions{},
				WithCatalogCWDResolver(resolver.ResolveExisting),
			)
			result, err := catalog.Sync(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if len(result.IDs) != 0 {
				t.Fatalf("outside catalog IDs = %v, want none", result.IDs)
			}
			if _, err := os.Stat(projection.Path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("outside projection remains: %v", err)
			}
		})
	}
}

func TestSyncDoesNotPruneProjectionCreatedAfterListStarts(t *testing.T) {
	root := t.TempDir()
	logPath := filepath.Join(t.TempDir(), "rpc.log")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := Sync(ctx, root, helperCommand("empty-list-wait", logPath))
		done <- err
	}()

	deadline := time.Now().Add(2 * time.Second)
	listStarted := false
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(logPath)
		if strings.Contains(string(data), "thread/list") {
			listStarted = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !listStarted {
		t.Fatal("thread/list did not start")
	}
	projection, err := Materialize(root, Thread{ID: "created-during-sync", CWD: t.TempDir(), CreatedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath+".release", nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(projection.Path); err != nil {
		t.Fatalf("concurrently created projection was pruned: %v", err)
	}
}

func TestStartSessionPersistsEmptyThreadBeforeRead(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	logPath := t.TempDir() + "/rpc.log"

	projection, err := StartSession(
		ctx,
		t.TempDir(),
		helperCommand("unmaterialized", logPath),
		"/tmp/project",
		"gpt",
		"high",
	)
	if err != nil {
		t.Fatal(err)
	}
	if projection.NativeID != "thread-1" {
		t.Fatalf("native id = %q", projection.NativeID)
	}
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	methods := strings.Fields(string(data))
	want := []string{"initialize", "initialized", "thread/start", "thread/name/set", "thread/read"}
	if strings.Join(methods, ",") != strings.Join(want, ",") {
		t.Fatalf("RPC order = %v, want %v", methods, want)
	}
	metadata, err := ReadProjectionMetadata(projection.Path)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Model != "gpt" || metadata.Effort != "high" || string(metadata.ApprovalPolicy) != `"never"` || len(metadata.Sandbox) == 0 {
		t.Fatalf("projection settings = %+v", metadata)
	}
}
