package codex

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pi-web/internal/sessions"
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
	old := time.Now().Add(-projectionPruneGrace - time.Minute)
	if err := os.Chtimes(codexProjection.Path, old, old); err != nil {
		t.Fatal(err)
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

func TestSyncKeepsRecentProjectionMissingFromList(t *testing.T) {
	root := t.TempDir()
	projection, err := Materialize(root, Thread{ID: "recent", CWD: t.TempDir(), CreatedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(context.Background(), root, helperCommand("empty-list")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(projection.Path); err != nil {
		t.Fatalf("recent projection was pruned before Codex list convergence: %v", err)
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
