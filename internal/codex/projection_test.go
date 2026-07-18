package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pi-web/internal/sessions"
)

func item(id, kind string, fields map[string]any) ThreadItem {
	raw := map[string]json.RawMessage{}
	for k, v := range fields {
		raw[k], _ = json.Marshal(v)
	}
	return ThreadItem{ID: id, Type: kind, Raw: raw}
}

func TestProjectionStableKnownUnknownAndPreservation(t *testing.T) {
	root := t.TempDir()
	thread := Thread{ID: "native", CWD: "/tmp/work", Name: "Named", Preview: "Preview", Model: "gpt", Effort: "high", CreatedAt: 10, Turns: []Turn{{ID: "turn", StartedAt: 11, Items: []ThreadItem{
		item("u", "userMessage", map[string]any{"content": []any{map[string]any{"type": "text", "text": "ask"}}}),
		item("a", "agentMessage", map[string]any{"text": "answer"}), item("r", "reasoning", map[string]any{"summary": []string{"think"}}), item("p", "plan", map[string]any{"text": "plan"}),
		item("c", "commandExecution", map[string]any{"command": "pwd", "cwd": "/tmp/work", "aggregatedOutput": "/tmp/work", "exitCode": 0}),
		item("f", "fileChange", map[string]any{"changes": []any{map[string]any{"path": "a", "diff": "+x"}}, "status": "completed"}),
		item("m", "mcpToolCall", map[string]any{"server": "s", "tool": "t", "arguments": map[string]any{}, "result": map[string]any{"content": "ok"}}),
		item("d", "dynamicToolCall", map[string]any{"tool": "dynamic", "contentItems": []any{"ok"}}), item("co", "collabAgentToolCall", map[string]any{"tool": "spawnAgent", "status": "completed"}),
		item("sub", "subAgentActivity", map[string]any{"kind": "spawned"}), item("web", "webSearch", map[string]any{"query": "q"}), item("view", "imageView", map[string]any{"path": "x.png"}), item("sleep", "sleep", map[string]any{"durationMs": 1}), item("gen", "imageGeneration", map[string]any{"result": "x", "status": "done"}),
		item("review", "enteredReviewMode", map[string]any{"review": "review"}), item("compact", "contextCompaction", nil), item("future", "futureItem", map[string]any{"value": 42}),
	}}}}
	p, err := Materialize(root, thread)
	if err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(p.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(first), `"runtime":"codex"`) || !strings.Contains(string(first), `Unknown Codex item: futureItem`) || !strings.Contains(string(first), `"type":"toolCall"`) || !strings.Contains(string(first), `"content":[{"text":"answer","type":"text"}]`) {
		t.Fatalf("projection lacks required entries:\n%s", first)
	}
	oldModTime := time.Unix(100, 0)
	if err := os.Chtimes(p.Path, oldModTime, oldModTime); err != nil {
		t.Fatal(err)
	}
	if _, err := Materialize(root, thread); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(p.Path)
	if string(first) != string(second) {
		t.Fatal("projection is not stable")
	}
	info, err := os.Stat(p.Path)
	if err != nil || !info.ModTime().Equal(oldModTime) {
		t.Fatalf("unchanged projection was rewritten: modtime=%v err=%v", info.ModTime(), err)
	}
	f, err := os.OpenFile(p.Path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"type":"session_info","timestamp":"2025-01-01T00:00:00Z","name":"Local"}` + "\n" + `{"type":"label","id":"label","targetId":"codex-x","label":"keep"}` + "\n")
	_ = f.Close()
	if _, err := Materialize(root, thread); err != nil {
		t.Fatal(err)
	}
	preserved, _ := os.ReadFile(p.Path)
	if !strings.Contains(string(preserved), `"name":"Local"`) || !strings.Contains(string(preserved), `"label":"keep"`) {
		t.Fatalf("local entries lost: %s", preserved)
	}
	parsed, err := sessions.ParseFile(p.Path, sessions.EncodeProjectName(thread.CWD), p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Header["nativeId"] != "native" || parsed.Name != "Local" {
		t.Fatalf("projection not pican-compatible: %+v", parsed)
	}
	if len(parsed.Entries) == 0 || parsed.Entries[0]["parentId"] != nil {
		t.Fatalf("first conversation entry must be a root: %+v", parsed.Entries)
	}
}

func TestMaterializeCanonicalizesProjectPathAndPrunesDuplicate(t *testing.T) {
	root := t.TempDir()
	realProject := filepath.Join(t.TempDir(), "project")
	if err := os.Mkdir(realProject, 0755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "project-link")
	if err := os.Symlink(realProject, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	thread := testThread()
	thread.CWD = alias

	oldPath := filepath.Join(root, sessions.EncodeProjectName(alias), "codex-"+thread.ID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(oldPath), 0755); err != nil {
		t.Fatal(err)
	}
	oldEntries := projectThread(thread)
	oldEntries = append(oldEntries, map[string]any{"type": "label", "id": "local-label", "targetId": "codex-entry", "label": "keep", "timestamp": "2026-01-01T00:00:00Z"})
	if err := writeJSONLAtomic(oldPath, oldEntries); err != nil {
		t.Fatal(err)
	}

	projection, err := Materialize(root, thread)
	if err != nil {
		t.Fatal(err)
	}
	realProject = canonicalProjectPath(realProject)
	wantPath := filepath.Join(root, sessions.EncodeProjectName(realProject), filepath.Base(oldPath))
	if projection.Path != wantPath {
		t.Fatalf("path = %q, want %q", projection.Path, wantPath)
	}
	if _, err := os.Stat(oldPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("duplicate projection still exists: %v", err)
	}
	data, err := os.ReadFile(projection.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"label":"keep"`) || !strings.Contains(string(data), `"cwd":"`+realProject+`"`) {
		t.Fatalf("canonical projection did not preserve local state:\n%s", data)
	}
}

func TestMaterializeRefusesToOverwriteCorruptProjection(t *testing.T) {
	root := t.TempDir()
	thread := testThread()
	projection, err := Materialize(root, thread)
	if err != nil {
		t.Fatal(err)
	}
	corrupt := []byte("{not-json}\n")
	if err := os.WriteFile(projection.Path, corrupt, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Materialize(root, thread); err == nil {
		t.Fatal("expected corrupt projection error")
	}
	got, err := os.ReadFile(projection.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(corrupt) {
		t.Fatalf("corrupt source was overwritten: %q", got)
	}
}

func TestProjectionMetadataTurnResolutionAndLockedLabel(t *testing.T) {
	root := t.TempDir()
	original := testThread()
	original.Model = "gpt"
	original.Effort = "high"
	original.ApprovalPolicy = json.RawMessage(`"never"`)
	original.Sandbox = json.RawMessage(`{"type":"dangerFullAccess"}`)
	projection, err := Materialize(root, original)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := ReadProjectionMetadata(projection.Path)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.NativeID != "thread-1" || metadata.CWD != "/tmp/project" {
		t.Fatalf("metadata = %+v", metadata)
	}
	if err := RenameProjection(projection.Path, "local", nil); err != nil {
		t.Fatal(err)
	}
	threadWithoutSettings := testThread()
	if _, err := Materialize(root, threadWithoutSettings); err != nil {
		t.Fatal(err)
	}
	metadata, err = ReadProjectionMetadata(projection.Path)
	if err != nil || metadata.Model != original.Model || metadata.Effort != original.Effort || string(metadata.ApprovalPolicy) != `"never"` || string(metadata.Sandbox) != `{"type":"dangerFullAccess"}` {
		t.Fatalf("refresh lost projected settings: metadata=%+v err=%v", metadata, err)
	}
	parsed, err := sessions.ParseFile(projection.Path, "project", projection.ID)
	if err != nil {
		t.Fatal(err)
	}
	entryID, _ := parsed.Entries[1]["id"].(string)
	turnID, err := ResolveTurnID(projection.Path, entryID)
	if err != nil || turnID != "turn-1" {
		t.Fatalf("turn = %q, err = %v", turnID, err)
	}
	if err := LabelSessionEntry(projection.Path, entryID, "checkpoint", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveTurnID(projection.Path, parsed.Entries[0]["id"].(string)); !errors.Is(err, ErrNoTurnBoundary) {
		t.Fatalf("header boundary error = %v", err)
	}
}

func TestRenameSessionKeepsRequestedNameInProjection(t *testing.T) {
	root := t.TempDir()
	projection, err := RenameSession(context.Background(), root, helperCommand("normal"), "thread-1", "Renamed")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := sessions.ParseFile(projection.Path, "project", projection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Name != "Renamed" {
		t.Fatalf("name = %q", parsed.Name)
	}
}

func TestMapModels(t *testing.T) {
	got := MapModels([]Model{{ID: "catalog-id", Model: "gpt", DisplayName: "GPT", SupportedReasoningEfforts: []ReasoningEffort{{ReasoningEffort: "low"}, {ReasoningEffort: "high"}}}})
	if len(got) != 1 {
		t.Fatalf("bad mapping: %+v", got)
	}
	high := got[0].ThinkingLevelMap["high"]
	if got[0].Provider != Provider || got[0].ID != "gpt" || got[0].Model != "gpt" || !got[0].Reasoning || high == nil || *high != "high" || got[0].ThinkingLevelMap["minimal"] != nil {
		t.Fatalf("bad mapping: %+v", got)
	}
}
