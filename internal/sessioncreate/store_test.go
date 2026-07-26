package sessioncreate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name()))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(TableDDL); err != nil {
		db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewStore(db, func() time.Time {
		return time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	})
}

func TestValidateKeyBoundsAndControls(t *testing.T) {
	for _, key := range []string{"", " leading", "trailing ", "line\nbreak", string(make([]byte, MaxIdempotencyKeyBytes+1))} {
		if err := ValidateKey(key); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("ValidateKey(%q) = %v, want ErrInvalidKey", key, err)
		}
	}
	if err := ValidateKey("scotty-session-123"); err != nil {
		t.Fatalf("ValidateKey(valid) = %v", err)
	}
}

func TestClaimReplaysSameFingerprintAndRejectsConflict(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	first, err := store.Claim(ctx, "outer-1", "fingerprint-a", "codex", true)
	if err != nil || !first.Owner {
		t.Fatalf("first claim = %#v, %v", first, err)
	}
	replay, err := store.Claim(ctx, "outer-1", "fingerprint-a", "codex", true)
	if err != nil || replay.Owner {
		t.Fatalf("replay claim = %#v, %v", replay, err)
	}
	if _, err := store.Claim(ctx, "outer-1", "fingerprint-b", "codex", true); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting claim = %v, want ErrConflict", err)
	}
}

func TestConcurrentClaimsHaveOneOwner(t *testing.T) {
	store := newTestStore(t)
	var owners atomic.Int32
	var wg sync.WaitGroup
	errs := make(chan error, 32)
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claim, err := store.Claim(context.Background(), "outer-concurrent", "same", "codex", true)
			if err != nil {
				errs <- err
				return
			}
			if claim.Owner {
				owners.Add(1)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if got := owners.Load(); got != 1 {
		t.Fatalf("owners = %d, want 1", got)
	}
}

func TestWaitForMappingConvergesOnOwnerIdentity(t *testing.T) {
	store := newTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := store.Claim(ctx, "outer-wait", "same", "codex", false); err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(20 * time.Millisecond)
		_, _ = store.MarkCreated(context.Background(), "outer-wait", "same", "pican.jsonl", "codex", "native")
	}()
	record, err := store.WaitForMapping(ctx, "outer-wait", "same", time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if record.SessionID != "pican.jsonl" || record.NativeID != "native" {
		t.Fatalf("record = %#v", record)
	}
}

func TestPromptDispatchOpportunityIsConsumedAtMostOnce(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if _, err := store.Claim(ctx, "outer-prompt", "same", "codex", true); err != nil {
		t.Fatal(err)
	}
	record, err := store.MarkCreated(ctx, "outer-prompt", "same", "pican.jsonl", "codex", "native")
	if err != nil || record.PromptState != PromptStatePending {
		t.Fatalf("MarkCreated = %#v, %v", record, err)
	}
	record, dispatch, err := store.BeginPromptDispatch(ctx, "outer-prompt", "same")
	if err != nil || !dispatch || record.PromptState != PromptStateDispatching {
		t.Fatalf("first BeginPromptDispatch = %#v, %v, %v", record, dispatch, err)
	}
	record, dispatch, err = store.BeginPromptDispatch(ctx, "outer-prompt", "same")
	if err != nil || dispatch || record.PromptState != PromptStateDispatching {
		t.Fatalf("replay BeginPromptDispatch = %#v, %v, %v", record, dispatch, err)
	}
	record, err = store.MarkPromptAccepted(ctx, "outer-prompt", "same")
	if err != nil || record.PromptState != PromptStateAccepted {
		t.Fatalf("MarkPromptAccepted = %#v, %v", record, err)
	}
	if _, err := store.MarkPromptUnknown(ctx, "outer-prompt", "same"); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("accepted -> unknown = %v, want ErrInvalidState", err)
	}
}

func TestUnknownStatesCannotBeRetried(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if _, err := store.Claim(ctx, "outer-unknown-create", "a", "codex", false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkCreateUnknown(ctx, "outer-unknown-create", "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkCreated(ctx, "outer-unknown-create", "a", "pican.jsonl", "codex", "native"); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("unknown create -> created = %v, want ErrInvalidState", err)
	}

	if _, err := store.Claim(ctx, "outer-unknown-prompt", "b", "codex", true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkCreated(ctx, "outer-unknown-prompt", "b", "pican.jsonl", "codex", "native"); err != nil {
		t.Fatal(err)
	}
	if _, dispatch, err := store.BeginPromptDispatch(ctx, "outer-unknown-prompt", "b"); err != nil || !dispatch {
		t.Fatalf("BeginPromptDispatch = %v, %v", dispatch, err)
	}
	if _, err := store.MarkPromptUnknown(ctx, "outer-unknown-prompt", "b"); err != nil {
		t.Fatal(err)
	}
	if _, dispatch, err := store.BeginPromptDispatch(ctx, "outer-unknown-prompt", "b"); err != nil || dispatch {
		t.Fatalf("unknown prompt redispatch = %v, %v", dispatch, err)
	}
}

func TestRecoverInterruptedMakesAmbiguityExplicit(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if _, err := store.Claim(ctx, "outer-creating", "a", "codex", false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(ctx, "outer-dispatching", "b", "codex", true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkCreated(ctx, "outer-dispatching", "b", "pican.jsonl", "codex", "native"); err != nil {
		t.Fatal(err)
	}
	if _, dispatch, err := store.BeginPromptDispatch(ctx, "outer-dispatching", "b"); err != nil || !dispatch {
		t.Fatalf("BeginPromptDispatch = %v, %v", dispatch, err)
	}

	if err := store.RecoverInterrupted(ctx); err != nil {
		t.Fatal(err)
	}
	creating, err := store.Get(ctx, "outer-creating")
	if err != nil || creating.CreateState != CreateStateUnknown {
		t.Fatalf("creating recovery = %#v, %v", creating, err)
	}
	dispatching, err := store.Get(ctx, "outer-dispatching")
	if err != nil || dispatching.PromptState != PromptStateUnknown {
		t.Fatalf("dispatch recovery = %#v, %v", dispatching, err)
	}
}
