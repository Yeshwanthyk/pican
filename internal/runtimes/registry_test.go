package runtimes

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"pican/internal/workers"
)

type fakeCatalog struct {
	result CatalogResult
	err    error
}

func (f fakeCatalog) Sync(context.Context) (CatalogResult, error) { return f.result, f.err }

func testFactory(string, string) (workers.ChatWorker, error) { return nil, nil }

func available(context.Context) Availability { return Availability{Available: true} }

func validRegistration(id ID) Registration {
	return Registration{
		Descriptor: Descriptor{
			ID:             id,
			Label:          strings.ToUpper(string(id)),
			Command:        string(id),
			ProjectionMode: ProjectionAppendOnlyNative,
		},
		AvailabilityProbe: available,
	}
}

func TestParseIDIsOpenAndValidated(t *testing.T) {
	for _, value := range []string{"pi", "codex", "opencode", "claude-code", "runtime2"} {
		id, err := ParseID(value)
		if err != nil || string(id) != value {
			t.Fatalf("ParseID(%q) = %q, %v", value, id, err)
		}
	}
	for _, value := range []string{"", "Pi", "2runtime", "claude_ code", "../pi", "claude-", "claude--code", " claude"} {
		if _, err := ParseID(value); !errors.Is(err, ErrInvalidID) {
			t.Fatalf("ParseID(%q) error = %v, want ErrInvalidID", value, err)
		}
	}
}

func TestRegistryPreservesRegistrationOrderAndRejectsDuplicates(t *testing.T) {
	registry, err := New(validRegistration(PiID), validRegistration(CodexID), validRegistration("future-runtime"))
	if err != nil {
		t.Fatal(err)
	}
	want := []ID{PiID, CodexID, "future-runtime"}
	if got := registry.IDs(); !reflect.DeepEqual(got, want) {
		t.Fatalf("IDs() = %v, want %v", got, want)
	}
	listed := registry.List()
	listed[0] = Registration{}
	if got := registry.List()[0].Descriptor.ID; got != PiID {
		t.Fatalf("List returned registry-owned storage; first ID = %q", got)
	}
	if err := registry.Register(validRegistration(PiID)); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("duplicate Register error = %v, want ErrDuplicateID", err)
	}
}

func TestRegistryOpenDistinguishesInvalidAndUnknownIDs(t *testing.T) {
	registry, err := New(validRegistration(PiID))
	if err != nil {
		t.Fatal(err)
	}
	if registration, err := registry.Open("pi"); err != nil || registration.Descriptor.ID != PiID {
		t.Fatalf("Open(pi) = %+v, %v", registration, err)
	}
	if _, err := registry.Open("PI"); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("Open(PI) error = %v, want ErrInvalidID", err)
	}
	if _, err := registry.Open("codex"); !errors.Is(err, ErrNotRegistered) {
		t.Fatalf("Open(codex) error = %v, want ErrNotRegistered", err)
	}
}

func TestRegistrationValidationLocksAdapterInvariants(t *testing.T) {
	tests := []struct {
		name         string
		registration Registration
		want         string
	}{
		{"label", Registration{Descriptor: Descriptor{ID: PiID, Command: "pi", ProjectionMode: ProjectionAppendOnlyNative}, AvailabilityProbe: available}, "label is required"},
		{"command", Registration{Descriptor: Descriptor{ID: PiID, Label: "Pi", ProjectionMode: ProjectionAppendOnlyNative}, AvailabilityProbe: available}, "command is required"},
		{"projection", Registration{Descriptor: Descriptor{ID: PiID, Label: "Pi", Command: "pi", ProjectionMode: "native"}, AvailabilityProbe: available}, "invalid projection mode"},
		{"probe", Registration{Descriptor: Descriptor{ID: PiID, Label: "Pi", Command: "pi", ProjectionMode: ProjectionAppendOnlyNative}}, "availability probe is required"},
		{"chat factory", Registration{Descriptor: Descriptor{ID: PiID, Label: "Pi", Command: "pi", ProjectionMode: ProjectionAppendOnlyNative, Capabilities: Capabilities{Chat: true}}, AvailabilityProbe: available}, "chat capability requires a worker factory"},
		{"replaceable catalog", Registration{Descriptor: Descriptor{ID: CodexID, Label: "Codex", Command: "codex", ProjectionMode: ProjectionReplaceable}, AvailabilityProbe: available}, "replaceable projection requires a catalog adapter"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := New(tt.registration)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("New() error = %v, want containing %q", err, tt.want)
			}
		})
	}
}

func TestBuiltinPiAndCodexDescriptors(t *testing.T) {
	catalog := fakeCatalog{result: CatalogResult{SessionIDs: []string{"thread-1"}, Complete: true}}
	registry, err := New(
		Pi(BuiltinOptions{Command: "/bin/pi", Version: "0.80.10", AvailabilityProbe: available, WorkerFactory: testFactory}),
		Codex(BuiltinOptions{Command: "/bin/codex", Version: "0.144.5", AvailabilityProbe: available, Catalog: catalog, WorkerFactory: testFactory}),
	)
	if err != nil {
		t.Fatal(err)
	}
	registrations := registry.List()
	if len(registrations) != 2 {
		t.Fatalf("registrations = %d, want 2", len(registrations))
	}
	pi, codex := registrations[0], registrations[1]
	if pi.Descriptor.ID != PiID || pi.Descriptor.Label != "Pi" || pi.Descriptor.Command != "/bin/pi" || pi.Descriptor.Version != "0.80.10" || pi.Descriptor.ProjectionMode != ProjectionAppendOnlyNative || pi.Catalog != nil || pi.WorkerFactory == nil {
		t.Fatalf("Pi registration = %+v", pi)
	}
	if codex.Descriptor.ID != CodexID || codex.Descriptor.Label != "Codex" || codex.Descriptor.Command != "/bin/codex" || codex.Descriptor.Version != "0.144.5" || codex.Descriptor.ProjectionMode != ProjectionReplaceable || codex.Catalog == nil || codex.WorkerFactory == nil {
		t.Fatalf("Codex registration = %+v", codex)
	}

	wantPi := Capabilities{Create: true, Resume: true, Fork: true, Clone: true, Rename: true, Chat: true, Cancel: true, Steer: true, PersistentQueue: true, Images: true, ModelListing: true, ModelSwitching: true, ReasoningSelection: true, SlashCommands: true, Subagents: true, InteractiveApprovals: true, UserQuestions: true}
	wantCodex := Capabilities{Create: true, Resume: true, Fork: true, Clone: true, Rename: true, Archive: true, Unarchive: true, Delete: true, Chat: true, Cancel: true, Steer: true, PersistentQueue: true, Images: true, ModelListing: true, ModelSwitching: true, EffortSelection: true, ReasoningSelection: true, SlashCommands: true}
	if got := pi.Descriptor.Capabilities; got != wantPi {
		t.Fatalf("Pi capabilities = %+v, want %+v", got, wantPi)
	}
	if got := codex.Descriptor.Capabilities; got != wantCodex {
		t.Fatalf("Codex capabilities = %+v, want %+v", got, wantCodex)
	}

	result, err := codex.Catalog.Sync(context.Background())
	if err != nil || !result.Complete || !reflect.DeepEqual(result.SessionIDs, []string{"thread-1"}) {
		t.Fatalf("Codex catalog result = %+v, %v", result, err)
	}
}

func TestAvailabilityNormalizesReasons(t *testing.T) {
	registration := validRegistration(PiID)
	registration.Descriptor.Label = "Pi"
	registration.AvailabilityProbe = func(context.Context) Availability {
		return Availability{Available: false}
	}
	registry, err := New(registration)
	if err != nil {
		t.Fatal(err)
	}
	status, err := registry.Availability(context.Background(), "pi")
	if err != nil || status.Available || status.Reason != "Pi runtime is unavailable" {
		t.Fatalf("Availability(pi) = %+v, %v", status, err)
	}

	registration.Descriptor.ID = CodexID
	registration.Descriptor.Label = "Codex"
	registration.AvailabilityProbe = func(context.Context) Availability {
		return Availability{Available: true, Reason: "stale failure"}
	}
	registry, err = New(registration)
	if err != nil {
		t.Fatal(err)
	}
	status, err = registry.Availability(context.Background(), "codex")
	if err != nil || !status.Available || status.Reason != "" {
		t.Fatalf("Availability(codex) = %+v, %v", status, err)
	}
}

func TestDescriptorJSONContainsCompleteMetadata(t *testing.T) {
	descriptor := Codex(BuiltinOptions{Command: "codex", Version: "1.2.3", AvailabilityProbe: available, Catalog: fakeCatalog{}, WorkerFactory: testFactory}).Descriptor
	data, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{
		`"id":"codex"`, `"label":"Codex"`, `"command":"codex"`, `"version":"1.2.3"`,
		`"projectionMode":"replaceable-projection"`, `"create":true`, `"resume":true`,
		`"fork":true`, `"clone":true`, `"rename":true`, `"archive":true`, `"unarchive":true`,
		`"delete":true`, `"chat":true`, `"cancel":true`, `"steer":true`, `"persistentQueue":true`,
		`"images":true`, `"files":false`, `"modelListing":true`, `"modelSwitching":true`,
		`"effortSelection":true`, `"reasoningSelection":true`, `"slashCommands":true`,
		`"subagents":false`, `"interactiveApprovals":false`, `"userQuestions":false`,
	} {
		if !strings.Contains(string(data), field) {
			t.Fatalf("descriptor JSON %s missing %s", data, field)
		}
	}
}

func TestNewWorkerDispatchesByValidatedRuntimeID(t *testing.T) {
	factoryErr := errors.New("factory called")
	var gotID, gotPath string
	registration := validRegistration("future")
	registration.Descriptor.Capabilities.Chat = true
	registration.WorkerFactory = func(sessionID, sessionPath string) (workers.ChatWorker, error) {
		gotID, gotPath = sessionID, sessionPath
		return nil, factoryErr
	}
	registry, err := New(registration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.NewWorker("future", "session.jsonl", "/tmp/session.jsonl"); !errors.Is(err, factoryErr) {
		t.Fatalf("NewWorker error = %v, want factory error", err)
	}
	if gotID != "session.jsonl" || gotPath != "/tmp/session.jsonl" {
		t.Fatalf("factory args = %q, %q", gotID, gotPath)
	}
	if _, err := registry.NewWorker("not_registered", "", ""); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("invalid dispatch error = %v, want ErrInvalidID", err)
	}

	registration = validRegistration("catalog-only")
	registration.WorkerFactory = testFactory
	registry, err = New(registration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.NewWorker("catalog-only", "", ""); err == nil || !strings.Contains(err.Error(), "does not support chat") {
		t.Fatalf("capability-disabled dispatch error = %v", err)
	}
}
