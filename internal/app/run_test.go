package app

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"pican/internal/agentdir"
	"pican/internal/ui"
)

func TestServeUntilCanceledStopsHTTPServer(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serveUntilCanceled(ctx, server, listener)
	}()

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveUntilCanceled() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("serveUntilCanceled did not return after cancellation")
	}
}

func TestCleanupStackClosesInReverseInitializationOrder(t *testing.T) {
	var got []string
	cleanups := cleanupStack{}
	cleanups.add(func() { got = append(got, "first") })
	cleanups.add(func() { got = append(got, "second") })
	cleanups.add(func() { got = append(got, "partial") })

	cleanups.close()

	want := []string{"partial", "second", "first"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cleanup order = %v, want %v", got, want)
	}
}

func TestHostedModeRejectsNonCodexRuntime(t *testing.T) {
	config := DefaultConfig("test")
	config.Mode = ModeHosted
	config.WorkspaceRoot = t.TempDir()
	config.Runtime = "claude"

	err := config.validate()
	if err == nil || err.Error() != "hosted mode supports only the Codex runtime" {
		t.Fatalf("validate() error = %v", err)
	}
}

func TestHostNavigationURLValidation(t *testing.T) {
	for _, test := range []struct {
		name    string
		value   string
		wantErr bool
	}{
		{name: "empty"},
		{name: "same origin path", value: "/workspaces/test"},
		{name: "https URL", value: "https://host.example/workspaces/test"},
		{name: "URL with fragment", value: "https://host.example/workspaces/test#thread"},
		{name: "http URL", value: "http://localhost:3000/workspaces/test"},
		{name: "relative path", value: "workspaces/test", wantErr: true},
		{name: "protocol relative", value: "//host.example/workspaces/test", wantErr: true},
		{name: "script scheme", value: "javascript:alert(1)", wantErr: true},
		{name: "credentials", value: "https://user:secret@host.example/", wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := DefaultConfig("test")
			config.HostNavigationURL = test.value
			err := config.validate()
			if (err != nil) != test.wantErr {
				t.Fatalf("validate() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestHostedModeDoesNotRegisterPWAHandlers(t *testing.T) {
	for _, test := range []struct {
		mode       Mode
		wantStatus int
	}{
		{mode: ModeStandalone, wantStatus: http.StatusOK},
		{mode: ModeHosted, wantStatus: http.StatusNotFound},
	} {
		t.Run(string(test.mode), func(t *testing.T) {
			mux := http.NewServeMux()
			registerPWAHandlers(mux, test.mode)
			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/sw.js", nil))
			if recorder.Code != test.wantStatus {
				t.Fatalf("GET /sw.js status = %d, want %d", recorder.Code, test.wantStatus)
			}
		})
	}
}

func TestBrowserApplicationContextExcludesStartupSecrets(t *testing.T) {
	config := DefaultConfig("test")
	config.Mode = ModeHosted
	config.HostNavigationURL = "https://host.example/workspaces/test"
	config.WorkspaceRoot = "/private/workspace-secret"
	config.StateRoot = "/private/state-secret"
	config.ProxyAuthHeader = "X-Private-Auth-Header"
	config.AuthToken = "proxy-token-secret"
	config.ChildEnv = []string{"PROVIDER_TOKEN=provider-secret"}

	var output strings.Builder
	if err := ui.RenderAppShellWithContext(&output, "", browserApplicationContext(config)); err != nil {
		t.Fatal(err)
	}
	html := output.String()
	for _, secret := range []string{
		config.WorkspaceRoot,
		config.StateRoot,
		config.ProxyAuthHeader,
		config.AuthToken,
		config.ChildEnv[0],
	} {
		if strings.Contains(html, secret) {
			t.Fatalf("initial HTML exposed %q", secret)
		}
	}
}

func TestRunCancellationRemovesStateFileAndStopsOwnedServer(t *testing.T) {
	stateRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stateRoot, "sessions"), 0o755); err != nil {
		t.Fatalf("create sessions directory: %v", err)
	}

	defaultModelsCache.mu.Lock()
	oldEntry := defaultModelsCache.entry
	defaultModelsCache.entry = &modelsCacheEntry{
		data: json.RawMessage(`{"models":[]}`),
		at:   time.Now(),
	}
	defaultModelsCache.mu.Unlock()
	t.Cleanup(func() {
		defaultModelsCache.mu.Lock()
		defaultModelsCache.entry = oldEntry
		defaultModelsCache.mu.Unlock()
	})

	config := DefaultConfig("test")
	config.StateRoot = stateRoot
	config.ListenAddress = "127.0.0.1:0"
	config.HostExplicit = true
	config.Runtime = "pi"

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, config)
	}()

	statePath := filepath.Join(agentdir.PicanDir(stateRoot), "pican-state.json")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(statePath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("Run did not finish startup")
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancellation")
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("state file remains after Run returned: %v", err)
	}
}
