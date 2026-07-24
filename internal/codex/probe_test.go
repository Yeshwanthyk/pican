package codex

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"pican/internal/runtimes"
)

func TestProbeReportsInstalledAuthenticatedCodex(t *testing.T) {
	var calls [][]string
	probe := newProbe("/custom/codex", time.Hour, func(_ context.Context, executable string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{executable}, args...))
		switch args[0] {
		case "--version":
			return []byte("codex-cli 0.145.0\n"), nil
		case "login":
			return []byte("Logged in using ChatGPT\n"), nil
		default:
			t.Fatalf("unexpected args: %v", args)
			return nil, nil
		}
	})

	if got := probe.Refresh(context.Background()); !got.Available || got.Reason != "" {
		t.Fatalf("availability = %+v", got)
	}
	if got := probe.Version(); got != "0.145.0" {
		t.Fatalf("version = %q", got)
	}
	wantCalls := [][]string{{"/custom/codex", "--version"}, {"/custom/codex", "login", "status"}}
	if !reflect.DeepEqual(calls, wantCalls) {
		t.Fatalf("calls = %#v, want %#v", calls, wantCalls)
	}

	_ = probe.Availability(context.Background())
	if len(calls) != 2 {
		t.Fatalf("cached probe made %d calls", len(calls))
	}
}

func TestProbeSeparatesExecutableAndAuthenticationFailures(t *testing.T) {
	tests := []struct {
		name   string
		runner probeRunner
		want   runtimes.Availability
	}{
		{
			name: "executable",
			runner: func(context.Context, string, ...string) ([]byte, error) {
				return nil, errors.New("not found")
			},
			want: runtimes.Availability{Reason: "Codex executable is unavailable: not found"},
		},
		{
			name: "authentication",
			runner: func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if args[0] == "--version" {
					return []byte("codex-cli 0.145.0"), nil
				}
				return []byte("Not logged in"), errors.New("exit status 1")
			},
			want: runtimes.Availability{Reason: "Codex authentication is unavailable: Not logged in"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			probe := newProbe("codex", time.Hour, test.runner)
			if got := probe.Refresh(context.Background()); got != test.want {
				t.Fatalf("availability = %+v, want %+v", got, test.want)
			}
		})
	}
}
