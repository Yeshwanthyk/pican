package opencode

import (
	"context"
	"os"
	"testing"
)

func TestServiceCreateRenameForkChildrenStatusAndDelete(t *testing.T) {
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	source := testNativeSession("source", cwd, "source")
	created := testNativeSession("created", cwd, "created")
	renamed := testNativeSession("source", cwd, "renamed")
	forked := testNativeSession("forked", cwd, "forked")
	forked.ParentID = "source"
	fake := &fakeNativeClient{
		sessions: map[string]Session{"source": source, "created": created, "forked": forked},
		messages: map[string][]Message{
			"source":  {testMessage("source", "msg-source", "user")},
			"created": {}, "forked": {},
		},
		messageErr: map[string]error{},
		created:    created, updated: renamed, forked: forked, deleted: true,
		children: []Session{forked},
		status:   map[string]SessionStatus{"source": {Type: "busy"}},
	}
	service, err := NewService(sessionsDir, cwd, providerFor(fake))
	if err != nil {
		t.Fatal(err)
	}

	createdProjection, err := service.StartSession(context.Background(), cwd, "anthropic/claude-sonnet")
	if err != nil {
		t.Fatal(err)
	}
	if fake.lastCreate.Title != newSessionTitle {
		t.Fatalf("create request = %+v", fake.lastCreate)
	}
	metadata, err := ReadProjectionMetadata(createdProjection.Path)
	if err != nil || metadata.Model != "anthropic/claude-sonnet" {
		t.Fatalf("created metadata = %+v, err = %v", metadata, err)
	}
	if _, err := service.RenameSession(context.Background(), "source", cwd, "renamed"); err != nil {
		t.Fatal(err)
	}
	if fake.lastUpdate.Title != "renamed" {
		t.Fatalf("update request = %+v", fake.lastUpdate)
	}
	messageID := "msg-source"
	forkProjection, err := service.ForkSession(context.Background(), "source", cwd, messageID)
	if err != nil {
		t.Fatal(err)
	}
	if fake.lastFork.MessageID != messageID {
		t.Fatalf("fork request = %+v", fake.lastFork)
	}
	if _, err := service.CloneSession(context.Background(), "source", cwd); err != nil {
		t.Fatal(err)
	}
	if fake.lastFork.MessageID != "" {
		t.Fatalf("clone request = %+v", fake.lastFork)
	}
	if _, err := service.CloneSession(context.Background(), "source", cwd); err != nil {
		t.Fatal(err)
	}
	if fake.lastFork.MessageID != "" {
		t.Fatalf("clone request = %+v", fake.lastFork)
	}
	children, err := service.Children(context.Background(), "source", cwd)
	if err != nil || len(children) != 1 || children[0].ID != "forked" {
		t.Fatalf("children = %+v, err = %v", children, err)
	}
	status, err := service.Status(context.Background(), cwd)
	if err != nil || status["source"].Type != "busy" {
		t.Fatalf("status = %+v, err = %v", status, err)
	}
	if err := service.DeleteSession(context.Background(), "forked", cwd); err != nil {
		t.Fatal(err)
	}
	if fake.lastDelete != "forked" {
		t.Fatalf("deleted = %q", fake.lastDelete)
	}
	if _, err := os.Stat(forkProjection.Path); !os.IsNotExist(err) {
		t.Fatalf("projection retained after native delete: %v", err)
	}
}

func TestServiceRejectsCrossDirectoryMutationBeforeNativeWrite(t *testing.T) {
	cwd := t.TempDir()
	foreign := t.TempDir()
	source := testNativeSession("source", foreign, "source")
	fake := &fakeNativeClient{
		sessions: map[string]Session{"source": source},
		messages: map[string][]Message{}, messageErr: map[string]error{},
	}
	service, err := NewService(t.TempDir(), cwd, providerFor(fake))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.RenameSession(context.Background(), "source", cwd, "renamed"); err == nil {
		t.Fatal("cross-directory rename succeeded")
	}
	if fake.lastUpdate.Title != "" {
		t.Fatal("native update ran before cwd validation")
	}
}
