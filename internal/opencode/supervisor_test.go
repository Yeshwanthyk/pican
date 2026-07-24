package opencode

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestOpenCodeHelperProcess(t *testing.T) {
	if os.Getenv("PICAN_OPENCODE_HELPER") != "1" {
		return
	}
	args := os.Args
	separator := -1
	for index, arg := range args {
		if arg == "--" {
			separator = index
			break
		}
	}
	if separator < 0 {
		os.Exit(90)
	}
	args = args[separator+1:]
	if os.Getenv("PICAN_OPENCODE_HELPER_MODE") == "exit" {
		os.Exit(3)
	}
	var port string
	for index := range args {
		if args[index] == "--port" && index+1 < len(args) {
			port = args[index+1]
		}
	}
	if _, err := strconv.Atoi(port); err != nil {
		os.Exit(91)
	}
	username := os.Getenv("OPENCODE_SERVER_USERNAME")
	password := os.Getenv("OPENCODE_SERVER_PASSWORD")
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotUsername, gotPassword, ok := request.BasicAuth()
		if !ok || gotUsername != username || gotPassword != password || password == "" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch request.URL.Path {
		case "/global/health":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"healthy":true,"version":"1.18.4"}`))
		case "/global/event":
			writer.Header().Set("Content-Type", "text/event-stream")
			writer.(http.Flusher).Flush()
			properties, _ := json.Marshal(map[string]any{"sessionID": "ses-before-reconcile"})
			event, _ := json.Marshal(Event{
				Directory: os.TempDir(),
				Payload:   EventPayload{Type: "session.idle", Properties: properties},
			})
			_, _ = fmt.Fprintf(writer, "data: %s\n\n", event)
			writer.(http.Flusher).Flush()
			<-request.Context().Done()
		default:
			http.NotFound(writer, request)
		}
	})
	if delay, err := time.ParseDuration(os.Getenv("PICAN_OPENCODE_HELPER_CRASH_AFTER")); err == nil && delay > 0 {
		go func() {
			time.Sleep(delay)
			os.Exit(4)
		}()
	}
	if err := http.ListenAndServe("127.0.0.1:"+port, handler); err != nil {
		os.Exit(92)
	}
	os.Exit(0)
}

func TestSupervisorEstablishesSSEBeforeReconcileAndCleansProcess(t *testing.T) {
	t.Setenv("PICAN_OPENCODE_HELPER", "1")
	t.Setenv("PICAN_OPENCODE_HELPER_MODE", "serve")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	eventSeen := make(chan struct{}, 1)
	reconciled := make(chan struct{}, 1)
	supervisor := NewSupervisor(Options{
		Command:        executable,
		CommandArgs:    []string{"-test.run=TestOpenCodeHelperProcess", "--"},
		StartupTimeout: 2 * time.Second,
		Event: func(event Event) {
			if event.SessionID() == "ses-before-reconcile" {
				select {
				case eventSeen <- struct{}{}:
				default:
				}
			}
		},
		Reconcile: func(_ context.Context, _ *Client) error {
			reconciled <- struct{}{}
			return nil
		},
	})
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ready := supervisor.Ready(); !ready.Available || ready.Version != "1.18.4" {
		t.Fatalf("availability = %#v", ready)
	}
	select {
	case <-reconciled:
	default:
		t.Fatal("availability published before reconciliation")
	}
	select {
	case <-eventSeen:
	case <-time.After(time.Second):
		t.Fatal("global SSE event was not delivered")
	}
	if supervisor.PID() <= 0 || supervisor.StartedAt().IsZero() {
		t.Fatalf("invalid inspector state: pid=%d started=%s", supervisor.PID(), supervisor.StartedAt())
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
	if supervisor.PID() != 0 {
		t.Fatalf("PID after close = %d", supervisor.PID())
	}
}

func TestSupervisorDoesNotDeadlockWhenChildExitsDuringHealth(t *testing.T) {
	t.Setenv("PICAN_OPENCODE_HELPER", "1")
	t.Setenv("PICAN_OPENCODE_HELPER_MODE", "exit")
	executable, _ := os.Executable()
	supervisor := NewSupervisor(Options{
		Command:            executable,
		CommandArgs:        []string{"-test.run=TestOpenCodeHelperProcess", "--"},
		StartupTimeout:     time.Second,
		MaxRestartAttempts: 1,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := supervisor.Start(ctx)
	if err == nil || !strings.Contains(err.Error(), "exited before readiness") {
		t.Fatalf("Start error = %v", err)
	}
	if supervisor.PID() != 0 {
		t.Fatalf("PID after failed readiness = %d", supervisor.PID())
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorBoundsConsecutiveUnstableGenerations(t *testing.T) {
	t.Setenv("PICAN_OPENCODE_HELPER", "1")
	t.Setenv("PICAN_OPENCODE_HELPER_MODE", "serve")
	t.Setenv("PICAN_OPENCODE_HELPER_CRASH_AFTER", "120ms")
	executable, _ := os.Executable()
	supervisor := NewSupervisor(Options{
		Command:            executable,
		CommandArgs:        []string{"-test.run=TestOpenCodeHelperProcess", "--"},
		StartupTimeout:     time.Second,
		MinRestartBackoff:  10 * time.Millisecond,
		MaxRestartBackoff:  20 * time.Millisecond,
		MaxRestartAttempts: 2,
		StableGeneration:   time.Second,
	})
	availability, unsubscribe := supervisor.SubscribeAvailability()
	defer unsubscribe()
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(3 * time.Second)
	for {
		select {
		case state := <-availability:
			if state.Err != nil && strings.Contains(state.Err.Error(), "unstable generations") {
				if err := supervisor.Close(); err != nil {
					t.Fatal(err)
				}
				return
			}
		case <-deadline:
			_ = supervisor.Close()
			t.Fatal("supervisor did not exhaust unstable generation budget")
		}
	}
}
