// Package sessioncreate owns the durable idempotency state for hosted session
// creation. It deliberately records intent around native Codex calls instead
// of claiming atomicity with the external app-server process.
package sessioncreate

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
)

const MaxIdempotencyKeyBytes = 200

const TableDDL = `CREATE TABLE IF NOT EXISTS hosted_session_creates (
	idempotency_key TEXT PRIMARY KEY,
	fingerprint TEXT NOT NULL,
	create_state TEXT NOT NULL,
	session_id TEXT NOT NULL DEFAULT '',
	runtime TEXT NOT NULL,
	native_id TEXT NOT NULL DEFAULT '',
	prompt_state TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (create_state IN ('creating', 'created', 'unknown')),
	CHECK (prompt_state IN ('not_requested', 'pending', 'dispatching', 'accepted', 'unknown'))
)`

type CreateState string

const (
	CreateStateCreating CreateState = "creating"
	CreateStateCreated  CreateState = "created"
	CreateStateUnknown  CreateState = "unknown"
)

type PromptState string

const (
	PromptStateNotRequested PromptState = "not_requested"
	PromptStatePending      PromptState = "pending"
	PromptStateDispatching  PromptState = "dispatching"
	PromptStateAccepted     PromptState = "accepted"
	PromptStateUnknown      PromptState = "unknown"
)

var (
	ErrConflict      = errors.New("idempotency key reused with a different request")
	ErrInvalidKey    = errors.New("invalid idempotency key")
	ErrInvalidState  = errors.New("invalid session creation state transition")
	ErrRecordMissing = errors.New("session creation record not found")
)

type Record struct {
	Key         string
	Fingerprint string
	CreateState CreateState
	SessionID   string
	Runtime     string
	NativeID    string
	PromptState PromptState
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type Claim struct {
	Record Record
	Owner  bool
}

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func NewStore(db *sql.DB, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{db: db, now: now}
}

// RecoverInterrupted is called once while server startup is still
// single-threaded. A process exit can leave either native creation or prompt
// acceptance ambiguous; both states become terminal unknowns and are never
// retried automatically.
func (s *Store) RecoverInterrupted(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin session creation recovery: %w", err)
	}
	defer tx.Rollback()
	now := s.timestamp()
	if _, err := tx.ExecContext(ctx, `
		UPDATE hosted_session_creates
		SET create_state = ?, updated_at = ?
		WHERE create_state = ?`,
		CreateStateUnknown, now, CreateStateCreating); err != nil {
		return fmt.Errorf("recover interrupted native creation: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE hosted_session_creates
		SET prompt_state = ?, updated_at = ?
		WHERE create_state = ? AND prompt_state = ?`,
		PromptStateUnknown, now, CreateStateCreated, PromptStateDispatching); err != nil {
		return fmt.Errorf("recover interrupted prompt dispatch: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit session creation recovery: %w", err)
	}
	return nil
}

func ValidateKey(key string) error {
	if key == "" || len(key) > MaxIdempotencyKeyBytes || strings.TrimSpace(key) != key {
		return ErrInvalidKey
	}
	for _, r := range key {
		if unicode.IsControl(r) {
			return ErrInvalidKey
		}
	}
	return nil
}

// Fingerprint returns a stable digest for a normalized request value. Callers
// are responsible for canonicalizing filesystem paths and runtime defaults
// before invoking it.
func Fingerprint(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("marshal normalized session request: %w", err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func (s *Store) Claim(ctx context.Context, key, fingerprint, runtime string, hasPrompt bool) (Claim, error) {
	if s == nil || s.db == nil {
		return Claim{}, errors.New("session creation store unavailable")
	}
	if err := ValidateKey(key); err != nil {
		return Claim{}, err
	}
	if fingerprint == "" || runtime == "" {
		return Claim{}, errors.New("fingerprint and runtime are required")
	}
	promptState := PromptStateNotRequested
	if hasPrompt {
		promptState = PromptStatePending
	}
	now := s.now().UTC().Format(time.RFC3339Nano)
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO hosted_session_creates (
			idempotency_key, fingerprint, create_state, runtime, prompt_state, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(idempotency_key) DO NOTHING`,
		key, fingerprint, CreateStateCreating, runtime, promptState, now, now)
	if err != nil {
		return Claim{}, fmt.Errorf("claim idempotency key: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Claim{}, fmt.Errorf("read claim result: %w", err)
	}
	record, err := s.Get(ctx, key)
	if err != nil {
		return Claim{}, err
	}
	if record.Fingerprint != fingerprint {
		return Claim{}, ErrConflict
	}
	return Claim{Record: record, Owner: affected == 1}, nil
}

func (s *Store) Get(ctx context.Context, key string) (Record, error) {
	var record Record
	var createdAt, updatedAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT idempotency_key, fingerprint, create_state, session_id, runtime, native_id,
		       prompt_state, created_at, updated_at
		FROM hosted_session_creates
		WHERE idempotency_key = ?`, key).Scan(
		&record.Key,
		&record.Fingerprint,
		&record.CreateState,
		&record.SessionID,
		&record.Runtime,
		&record.NativeID,
		&record.PromptState,
		&createdAt,
		&updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, ErrRecordMissing
	}
	if err != nil {
		return Record{}, fmt.Errorf("read session creation record: %w", err)
	}
	record.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Record{}, fmt.Errorf("parse creation time: %w", err)
	}
	record.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Record{}, fmt.Errorf("parse update time: %w", err)
	}
	return record, nil
}

// WaitForMapping lets concurrent callers converge on the owner's durable
// native identity without starting a second thread.
func (s *Store) WaitForMapping(ctx context.Context, key, fingerprint string, pollInterval time.Duration) (Record, error) {
	if pollInterval <= 0 {
		pollInterval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		record, err := s.Get(ctx, key)
		if err != nil {
			return Record{}, err
		}
		if record.Fingerprint != fingerprint {
			return Record{}, ErrConflict
		}
		if record.CreateState != CreateStateCreating {
			return record, nil
		}
		select {
		case <-ctx.Done():
			return Record{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

// WaitForPromptResolution lets concurrent replays return the same terminal
// dispatch state when the owning request is still awaiting native acceptance.
func (s *Store) WaitForPromptResolution(ctx context.Context, key, fingerprint string, pollInterval time.Duration) (Record, error) {
	if pollInterval <= 0 {
		pollInterval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		record, err := s.Get(ctx, key)
		if err != nil {
			return Record{}, err
		}
		if record.Fingerprint != fingerprint {
			return Record{}, ErrConflict
		}
		if record.PromptState != PromptStateDispatching {
			return record, nil
		}
		select {
		case <-ctx.Done():
			return record, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Store) MarkCreated(ctx context.Context, key, fingerprint, sessionID, runtime, nativeID string) (Record, error) {
	if sessionID == "" || runtime == "" || nativeID == "" {
		return Record{}, errors.New("session, runtime, and native IDs are required")
	}
	return s.transition(ctx, key, fingerprint, `
		UPDATE hosted_session_creates
		SET create_state = ?, session_id = ?, runtime = ?, native_id = ?, updated_at = ?
		WHERE idempotency_key = ? AND fingerprint = ? AND create_state = ?`,
		CreateStateCreated, sessionID, runtime, nativeID, s.timestamp(), key, fingerprint, CreateStateCreating)
}

// MarkCreateUnknown records that native creation may have happened but no
// stable native identity was durably mapped. Retrying must not create another
// native thread automatically.
func (s *Store) MarkCreateUnknown(ctx context.Context, key, fingerprint string) (Record, error) {
	return s.transition(ctx, key, fingerprint, `
		UPDATE hosted_session_creates
		SET create_state = ?, updated_at = ?
		WHERE idempotency_key = ? AND fingerprint = ? AND create_state = ?`,
		CreateStateUnknown, s.timestamp(), key, fingerprint, CreateStateCreating)
}

// BeginPromptDispatch durably consumes the one dispatch opportunity. Once it
// returns true, retry callers must never move the row back to pending.
func (s *Store) BeginPromptDispatch(ctx context.Context, key, fingerprint string) (Record, bool, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE hosted_session_creates
		SET prompt_state = ?, updated_at = ?
		WHERE idempotency_key = ? AND fingerprint = ? AND create_state = ? AND prompt_state = ?`,
		PromptStateDispatching, s.timestamp(), key, fingerprint, CreateStateCreated, PromptStatePending)
	if err != nil {
		return Record{}, false, fmt.Errorf("claim prompt dispatch: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Record{}, false, fmt.Errorf("read prompt claim result: %w", err)
	}
	record, err := s.Get(ctx, key)
	if err != nil {
		return Record{}, false, err
	}
	if record.Fingerprint != fingerprint {
		return Record{}, false, ErrConflict
	}
	return record, affected == 1, nil
}

func (s *Store) MarkPromptAccepted(ctx context.Context, key, fingerprint string) (Record, error) {
	return s.transition(ctx, key, fingerprint, `
		UPDATE hosted_session_creates
		SET prompt_state = ?, updated_at = ?
		WHERE idempotency_key = ? AND fingerprint = ? AND create_state = ? AND prompt_state = ?`,
		PromptStateAccepted, s.timestamp(), key, fingerprint, CreateStateCreated, PromptStateDispatching)
}

// MarkPromptUnknown is the terminal recovery state for a dispatch whose
// external acceptance could not be proven. It is intentionally not retryable.
func (s *Store) MarkPromptUnknown(ctx context.Context, key, fingerprint string) (Record, error) {
	return s.transition(ctx, key, fingerprint, `
		UPDATE hosted_session_creates
		SET prompt_state = ?, updated_at = ?
		WHERE idempotency_key = ? AND fingerprint = ? AND create_state = ? AND prompt_state = ?`,
		PromptStateUnknown, s.timestamp(), key, fingerprint, CreateStateCreated, PromptStateDispatching)
}

func (s *Store) transition(ctx context.Context, key, fingerprint, query string, args ...any) (Record, error) {
	result, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return Record{}, fmt.Errorf("update session creation record: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Record{}, fmt.Errorf("read transition result: %w", err)
	}
	record, err := s.Get(ctx, key)
	if err != nil {
		return Record{}, err
	}
	if record.Fingerprint != fingerprint {
		return Record{}, ErrConflict
	}
	if affected != 1 {
		return record, ErrInvalidState
	}
	return record, nil
}

func (s *Store) timestamp() string {
	return s.now().UTC().Format(time.RFC3339Nano)
}
