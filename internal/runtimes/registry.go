// Package runtimes defines the startup-owned registry of agent runtimes.
// It intentionally models only shared dispatch metadata; native lifecycle
// operations stay on runtime-specific adapters.
package runtimes

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"pican/internal/workers"
)

var (
	ErrInvalidID     = errors.New("invalid runtime ID")
	ErrNotRegistered = errors.New("runtime is not registered")
	ErrDuplicateID   = errors.New("runtime is already registered")
)

// ID is an open runtime identifier. New runtimes do not require extending an
// enum, but IDs must be stable lowercase tokens suitable for persisted headers.
type ID string

// ParseID validates a runtime ID at an input boundary.
func ParseID(value string) (ID, error) {
	if value == "" || !isLowerLetter(value[0]) {
		return "", fmt.Errorf("%w: %q", ErrInvalidID, value)
	}
	for i := 1; i < len(value); i++ {
		c := value[i]
		if !isLowerLetter(c) && (c < '0' || c > '9') && c != '-' {
			return "", fmt.Errorf("%w: %q", ErrInvalidID, value)
		}
	}
	if value[len(value)-1] == '-' || strings.Contains(value, "--") {
		return "", fmt.Errorf("%w: %q", ErrInvalidID, value)
	}
	return ID(value), nil
}

func isLowerLetter(c byte) bool { return c >= 'a' && c <= 'z' }

// ProjectionMode states who owns conversation persistence.
type ProjectionMode string

const (
	ProjectionAppendOnlyNative ProjectionMode = "append-only-native"
	ProjectionReplaceable      ProjectionMode = "replaceable-projection"
)

func (m ProjectionMode) valid() bool {
	return m == ProjectionAppendOnlyNative || m == ProjectionReplaceable
}

// Capabilities records runtime operations explicitly. A false value means the
// operation is unavailable; callers must not emulate it silently.
type Capabilities struct {
	Create               bool `json:"create"`
	Resume               bool `json:"resume"`
	Fork                 bool `json:"fork"`
	Clone                bool `json:"clone"`
	Rename               bool `json:"rename"`
	Archive              bool `json:"archive"`
	Unarchive            bool `json:"unarchive"`
	Delete               bool `json:"delete"`
	Chat                 bool `json:"chat"`
	Cancel               bool `json:"cancel"`
	Steer                bool `json:"steer"`
	PersistentQueue      bool `json:"persistentQueue"`
	Images               bool `json:"images"`
	Files                bool `json:"files"`
	ModelListing         bool `json:"modelListing"`
	ModelSwitching       bool `json:"modelSwitching"`
	EffortSelection      bool `json:"effortSelection"`
	ReasoningSelection   bool `json:"reasoningSelection"`
	SlashCommands        bool `json:"slashCommands"`
	Subagents            bool `json:"subagents"`
	InteractiveApprovals bool `json:"interactiveApprovals"`
	UserQuestions        bool `json:"userQuestions"`
}

// Descriptor is stable, serializable runtime metadata. Command is the native
// executable name or configured path; Version is the probed native version.
type Descriptor struct {
	ID             ID             `json:"id"`
	Label          string         `json:"label"`
	Command        string         `json:"command"`
	Version        string         `json:"version,omitempty"`
	ProjectionMode ProjectionMode `json:"projectionMode"`
	Capabilities   Capabilities   `json:"capabilities"`
}

// Availability is the current state returned by an AvailabilityProbe.
type Availability struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// AvailabilityProbe is evaluated when current runtime health is needed.
type AvailabilityProbe func(context.Context) Availability

// CatalogResult describes one native catalog reconciliation. Complete must be
// true before an adapter may treat absence as deletion and prune projections.
type CatalogResult struct {
	SessionIDs []string
	Complete   bool
}

// CatalogAdapter reconciles a native catalog into pican projections. It is
// intentionally narrower than a universal session lifecycle interface.
type CatalogAdapter interface {
	Sync(context.Context) (CatalogResult, error)
}

// Registration binds descriptor metadata to the runtime's narrow adapters.
// Catalog is optional for append-only runtimes. WorkerFactory may be nil only
// when chat is not supported.
type Registration struct {
	Descriptor        Descriptor
	AvailabilityProbe AvailabilityProbe
	Catalog           CatalogAdapter
	WorkerFactory     workers.Factory
}

func (r Registration) validate() error {
	id, err := ParseID(string(r.Descriptor.ID))
	if err != nil {
		return err
	}
	if id != r.Descriptor.ID {
		return fmt.Errorf("%w: %q", ErrInvalidID, r.Descriptor.ID)
	}
	if strings.TrimSpace(r.Descriptor.Label) == "" {
		return fmt.Errorf("runtime %q: label is required", id)
	}
	if strings.TrimSpace(r.Descriptor.Command) == "" {
		return fmt.Errorf("runtime %q: command is required", id)
	}
	if !r.Descriptor.ProjectionMode.valid() {
		return fmt.Errorf("runtime %q: invalid projection mode %q", id, r.Descriptor.ProjectionMode)
	}
	if r.AvailabilityProbe == nil {
		return fmt.Errorf("runtime %q: availability probe is required", id)
	}
	if r.Descriptor.Capabilities.Chat && r.WorkerFactory == nil {
		return fmt.Errorf("runtime %q: chat capability requires a worker factory", id)
	}
	if r.Descriptor.ProjectionMode == ProjectionReplaceable && r.Catalog == nil {
		return fmt.Errorf("runtime %q: replaceable projection requires a catalog adapter", id)
	}
	return nil
}

// Registry preserves startup registration order while providing keyed lookup.
type Registry struct {
	mu      sync.RWMutex
	ordered []Registration
	byID    map[ID]int
}

func New(registrations ...Registration) (*Registry, error) {
	registry := &Registry{byID: make(map[ID]int, len(registrations))}
	for _, registration := range registrations {
		if err := registry.Register(registration); err != nil {
			return nil, err
		}
	}
	return registry, nil
}

// Register appends a registration. Duplicate IDs are rejected rather than
// replacing an existing runtime and silently changing startup order.
func (r *Registry) Register(registration Registration) error {
	if err := registration.validate(); err != nil {
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	id := registration.Descriptor.ID
	if _, exists := r.byID[id]; exists {
		return fmt.Errorf("%w: %q", ErrDuplicateID, id)
	}
	r.byID[id] = len(r.ordered)
	r.ordered = append(r.ordered, registration)
	return nil
}

// Open validates a string ID and returns its registration.
func (r *Registry) Open(value string) (Registration, error) {
	id, err := ParseID(value)
	if err != nil {
		return Registration{}, err
	}
	registration, ok := r.Lookup(id)
	if !ok {
		return Registration{}, fmt.Errorf("%w: %q", ErrNotRegistered, id)
	}
	return registration, nil
}

// Lookup returns a registration by an already validated ID.
func (r *Registry) Lookup(id ID) (Registration, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	index, ok := r.byID[id]
	if !ok {
		return Registration{}, false
	}
	return r.ordered[index], true
}

// List returns registrations in deterministic startup order.
func (r *Registry) List() []Registration {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]Registration(nil), r.ordered...)
}

// IDs returns registered IDs in deterministic startup order.
func (r *Registry) IDs() []ID {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]ID, len(r.ordered))
	for i, registration := range r.ordered {
		ids[i] = registration.Descriptor.ID
	}
	return ids
}

// Availability probes a registered runtime without conflating an unavailable
// runtime with an invalid or unregistered ID.
func (r *Registry) Availability(ctx context.Context, value string) (Availability, error) {
	registration, err := r.Open(value)
	if err != nil {
		return Availability{}, err
	}
	availability := registration.AvailabilityProbe(ctx)
	if availability.Available {
		availability.Reason = ""
	} else if strings.TrimSpace(availability.Reason) == "" {
		availability.Reason = registration.Descriptor.Label + " runtime is unavailable"
	}
	return availability, nil
}

// NewWorker dispatches worker creation through the registered runtime factory.
func (r *Registry) NewWorker(runtimeID, sessionID, sessionPath string) (workers.ChatWorker, error) {
	registration, err := r.Open(runtimeID)
	if err != nil {
		return nil, err
	}
	if !registration.Descriptor.Capabilities.Chat || registration.WorkerFactory == nil {
		return nil, fmt.Errorf("runtime %q does not support chat", registration.Descriptor.ID)
	}
	return registration.WorkerFactory(sessionID, sessionPath)
}
