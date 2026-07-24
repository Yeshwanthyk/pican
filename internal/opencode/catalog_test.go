package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

type fakeNativeClient struct {
	lists      [][]Session
	listCalls  int
	sessions   map[string]Session
	messages   map[string][]Message
	messageErr map[string]error
	created    Session
	updated    Session
	forked     Session
	deleted    bool
	children   []Session
	status     map[string]SessionStatus
	lastCreate CreateSessionRequest
	lastUpdate UpdateSessionRequest
	lastFork   ForkSessionRequest
	lastDelete string
	lastCWD    string
}

func (f *fakeNativeClient) ListSessions(context.Context, string) ([]Session, error) {
	if len(f.lists) == 0 {
		return nil, nil
	}
	index := f.listCalls
	if index >= len(f.lists) {
		index = len(f.lists) - 1
	}
	f.listCalls++
	return f.lists[index], nil
}
func (f *fakeNativeClient) GetSession(_ context.Context, id, _ string) (Session, error) {
	native, ok := f.sessions[id]
	if !ok {
		return Session{}, os.ErrNotExist
	}
	return native, nil
}
func (f *fakeNativeClient) CreateSession(_ context.Context, cwd string, request CreateSessionRequest) (Session, error) {
	f.lastCWD, f.lastCreate = cwd, request
	return f.created, nil
}
func (f *fakeNativeClient) UpdateSession(_ context.Context, id, cwd string, request UpdateSessionRequest) (Session, error) {
	f.lastCWD, f.lastUpdate = cwd, request
	return f.updated, nil
}
func (f *fakeNativeClient) DeleteSession(_ context.Context, id, cwd string) (bool, error) {
	f.lastDelete, f.lastCWD = id, cwd
	return f.deleted, nil
}
func (f *fakeNativeClient) ForkSession(_ context.Context, id, cwd string, request ForkSessionRequest) (Session, error) {
	f.lastCWD, f.lastFork = cwd, request
	return f.forked, nil
}
func (f *fakeNativeClient) Messages(_ context.Context, id, _ string) ([]Message, error) {
	if err := f.messageErr[id]; err != nil {
		return nil, err
	}
	return f.messages[id], nil
}
func (f *fakeNativeClient) Children(context.Context, string, string) ([]Session, error) {
	return f.children, nil
}
func (f *fakeNativeClient) Status(context.Context, string) (map[string]SessionStatus, error) {
	return f.status, nil
}

func providerFor(fake *fakeNativeClient) ClientProvider {
	return func() (NativeClient, error) { return fake, nil }
}

func testNativeSession(id, cwd, title string) Session {
	return Session{
		ID: id, Directory: cwd, Title: title, Time: SessionTime{Created: 1_700_000_000_000, Updated: 1_700_000_001_000},
		Raw: json.RawMessage(`{"id":"` + id + `","directory":"` + cwd + `","title":"` + title + `","time":{"created":1700000000000,"updated":1700000001000}}`),
	}
}

func testMessage(sessionID, messageID, role string, parts ...Part) Message {
	var info MessageInfo
	info.ID, info.SessionID, info.Role = messageID, sessionID, role
	info.Time.Created = 1_700_000_000_000
	info.Raw = json.RawMessage(`{"id":"` + messageID + `","sessionID":"` + sessionID + `","role":"` + role + `"}`)
	return Message{Info: info, Parts: parts}
}

func TestCatalogCompleteReconcilePrunesOnlyPreexistingMissingProjection(t *testing.T) {
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	stale, err := Materialize(sessionsDir, testNativeSession("stale", cwd, "stale"), nil)
	if err != nil {
		t.Fatal(err)
	}
	current := testNativeSession("current", cwd, "current")
	fake := &fakeNativeClient{
		lists:      [][]Session{{current}, {current}},
		sessions:   map[string]Session{"current": current},
		messages:   map[string][]Message{"current": {testMessage("current", "msg", "user")}},
		messageErr: map[string]error{},
	}
	catalog, err := NewCatalog(sessionsDir, cwd, providerFor(fake))
	if err != nil {
		t.Fatal(err)
	}
	result, err := catalog.Sync(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Complete || len(result.SessionIDs) != 1 {
		t.Fatalf("result = %+v", result)
	}
	if _, err := os.Stat(stale.Path); !os.IsNotExist(err) {
		t.Fatalf("stale projection retained after complete scan: %v", err)
	}
}

func TestCatalogPartialHydrationRetainsExistingProjections(t *testing.T) {
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	stale, err := Materialize(sessionsDir, testNativeSession("stale", cwd, "stale"), nil)
	if err != nil {
		t.Fatal(err)
	}
	broken := testNativeSession("broken", cwd, "broken")
	fake := &fakeNativeClient{
		lists:      [][]Session{{broken}},
		sessions:   map[string]Session{"broken": broken},
		messages:   map[string][]Message{},
		messageErr: map[string]error{"broken": errors.New("read failed")},
	}
	catalog, err := NewCatalog(sessionsDir, cwd, providerFor(fake))
	if err != nil {
		t.Fatal(err)
	}
	result, err := catalog.Sync(context.Background())
	if err == nil || result.Complete {
		t.Fatalf("result = %+v, err = %v", result, err)
	}
	if !errors.Is(err, ErrPartialCatalog) {
		t.Fatalf("partial error = %v", err)
	}
	if _, err := os.Stat(stale.Path); err != nil {
		t.Fatalf("partial scan pruned cached projection: %v", err)
	}
}

func TestCatalogChangingConfirmationNeverPrunes(t *testing.T) {
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	stale, err := Materialize(sessionsDir, testNativeSession("stale", cwd, "stale"), nil)
	if err != nil {
		t.Fatal(err)
	}
	current := testNativeSession("current", cwd, "current")
	appeared := testNativeSession("appeared", cwd, "appeared")
	fake := &fakeNativeClient{
		lists:      [][]Session{{current}, {current, appeared}},
		sessions:   map[string]Session{"current": current, "appeared": appeared},
		messages:   map[string][]Message{"current": nil, "appeared": nil},
		messageErr: map[string]error{},
	}
	catalog, err := NewCatalog(sessionsDir, cwd, providerFor(fake))
	if err != nil {
		t.Fatal(err)
	}
	result, err := catalog.Sync(context.Background())
	if err == nil || result.Complete {
		t.Fatalf("result = %+v, err = %v", result, err)
	}
	if _, err := os.Stat(stale.Path); err != nil {
		t.Fatalf("changing membership pruned cached projection: %v", err)
	}
}
