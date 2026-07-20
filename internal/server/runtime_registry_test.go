package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"pican/internal/runtimes"
)

func TestHandleRuntimesUsesRegistryOrderMetadataAndAvailability(t *testing.T) {
	registry, err := serverRuntimeRegistry(Deps{
		EnabledRuntimes: []string{"codex", "pi"},
		RuntimeAvailable: func(runtime string) (bool, string) {
			if runtime == "codex" {
				return false, "Codex runtime is unavailable: test"
			}
			return true, ""
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{defaultRuntime: "pi", runtimeRegistry: registry}
	recorder := httptest.NewRecorder()
	s.handleRuntimes(recorder, httptest.NewRequest(http.MethodGet, "/api/runtimes", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		DefaultRuntime string `json:"defaultRuntime"`
		Runtimes       []struct {
			ID             string                  `json:"id"`
			Label          string                  `json:"label"`
			Command        string                  `json:"command"`
			Available      bool                    `json:"available"`
			Reason         string                  `json:"reason"`
			ProjectionMode runtimes.ProjectionMode `json:"projectionMode"`
			Capabilities   runtimes.Capabilities   `json:"capabilities"`
		} `json:"runtimes"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.DefaultRuntime != "pi" {
		t.Fatalf("defaultRuntime = %q, want pi", response.DefaultRuntime)
	}
	if len(response.Runtimes) != 2 || response.Runtimes[0].ID != "codex" || response.Runtimes[1].ID != "pi" {
		t.Fatalf("runtime order = %+v, want codex then pi", response.Runtimes)
	}
	codex, pi := response.Runtimes[0], response.Runtimes[1]
	if codex.Label != "Codex" || codex.Command != "codex" || codex.Available || codex.Reason != "Codex runtime is unavailable: test" {
		t.Fatalf("Codex availability metadata = %+v", codex)
	}
	if codex.ProjectionMode != runtimes.ProjectionReplaceable || !codex.Capabilities.Archive || !codex.Capabilities.Delete || !codex.Capabilities.Chat {
		t.Fatalf("Codex descriptor metadata = %+v", codex)
	}
	if pi.Label != "Pi" || pi.Command != "pi" || !pi.Available || pi.Reason != "" {
		t.Fatalf("Pi availability metadata = %+v", pi)
	}
	if pi.ProjectionMode != runtimes.ProjectionAppendOnlyNative || !pi.Capabilities.Chat || !pi.Capabilities.Fork || pi.Capabilities.Archive {
		t.Fatalf("Pi descriptor metadata = %+v", pi)
	}
}

func TestCompatibilityRegistryDeduplicatesLegacyRuntimeList(t *testing.T) {
	registry, err := serverRuntimeRegistry(Deps{EnabledRuntimes: []string{"pi", "pi", "codex", "codex"}})
	if err != nil {
		t.Fatal(err)
	}
	ids := registry.IDs()
	if len(ids) != 2 || ids[0] != runtimes.PiID || ids[1] != runtimes.CodexID {
		t.Fatalf("runtime IDs = %v, want [pi codex]", ids)
	}
}

func TestNewDerivesDefaultFromProvidedCodexOnlyRegistry(t *testing.T) {
	registry, err := serverRuntimeRegistry(Deps{EnabledRuntimes: []string{"codex"}})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	s, err := New(Deps{AgentDir: dir, SessionsDir: dir, RuntimeRegistry: registry})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Shutdown)

	if s.defaultRuntime != "codex" {
		t.Fatalf("default runtime = %q, want first registered runtime codex", s.defaultRuntime)
	}
	if !s.runtimeEnabled("codex") || s.runtimeEnabled("pi") {
		t.Fatalf("registry enablement: codex=%v pi=%v", s.runtimeEnabled("codex"), s.runtimeEnabled("pi"))
	}
}

func TestNewUsesProvidedRegistryOrderForDefault(t *testing.T) {
	registry, err := serverRuntimeRegistry(Deps{EnabledRuntimes: []string{"codex", "pi"}})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	s, err := New(Deps{AgentDir: dir, SessionsDir: dir, RuntimeRegistry: registry})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Shutdown)
	if s.defaultRuntime != "codex" {
		t.Fatalf("default runtime = %q, want first registered runtime codex", s.defaultRuntime)
	}
}

func TestNewPreservesLegacyPiDefault(t *testing.T) {
	dir := t.TempDir()
	s, err := New(Deps{AgentDir: dir, SessionsDir: dir, EnabledRuntimes: []string{"codex", "pi"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Shutdown)
	if s.defaultRuntime != "pi" {
		t.Fatalf("legacy default runtime = %q, want pi", s.defaultRuntime)
	}
}

func TestNewRejectsDefaultOutsideRegistry(t *testing.T) {
	registry, err := serverRuntimeRegistry(Deps{EnabledRuntimes: []string{"pi"}})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if _, err := New(Deps{AgentDir: dir, SessionsDir: dir, RuntimeRegistry: registry, DefaultRuntime: "codex"}); err == nil {
		t.Fatal("New accepted a default runtime that is not registered")
	}
}
