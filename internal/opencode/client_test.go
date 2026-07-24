package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientAddsBasicAuthAndDirectoryScope(t *testing.T) {
	var authenticated atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		username, password, ok := request.BasicAuth()
		authenticated.Store(ok && username == "pican-test" && password == "generated-secret")
		if request.URL.Query().Get("directory") != "/private/tmp/project" {
			http.Error(writer, "missing directory", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(writer).Encode([]Session{})
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, 2*time.Second)
	if _, err := client.ListSessions(context.Background(), "/private/tmp/project"); err != nil {
		t.Fatal(err)
	}
	if !authenticated.Load() {
		t.Fatal("request did not carry generated Basic Auth")
	}
}

func TestClientOrdinaryRequestsTimeoutButSSEDoesNot(t *testing.T) {
	eventDelivered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/global/health":
			time.Sleep(80 * time.Millisecond)
			_ = json.NewEncoder(writer).Encode(Health{Healthy: true, Version: "test"})
		case "/global/event":
			writer.Header().Set("Content-Type", "text/event-stream")
			writer.WriteHeader(http.StatusOK)
			writer.(http.Flusher).Flush()
			time.Sleep(80 * time.Millisecond)
			_, _ = writer.Write([]byte("data: {\"directory\":\"/tmp\",\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
			writer.(http.Flusher).Flush()
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, 20*time.Millisecond)
	if _, err := client.Health(context.Background()); err == nil {
		t.Fatal("ordinary request ignored configured timeout")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := client.StreamEvents(ctx, func(Event) {
		select {
		case <-eventDelivered:
		default:
			close(eventDelivered)
			cancel()
		}
	})
	select {
	case <-eventDelivered:
	default:
		t.Fatalf("SSE event was killed by ordinary request timeout: %v", err)
	}
	if err == nil {
		t.Fatal("cancelled SSE stream returned nil")
	}
}

func TestClientRejectsCredentialRedirectAndReturnsTypedErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "native failure", http.StatusConflict)
	}))
	defer server.Close()
	client := newTestClient(t, server.URL, time.Second)
	_, err := client.GetSession(context.Background(), "ses_test", t.TempDir())
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusConflict {
		t.Fatalf("error = %T %v, want HTTP 409 APIError", err, err)
	}

	origin, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:1/global/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.http.Transport.RoundTrip(request)
	if err == nil {
		t.Fatalf("credentials escaped configured origin %s", origin)
	}
}

func newTestClient(t *testing.T, baseURL string, timeout time.Duration) *Client {
	t.Helper()
	client, err := NewClient(baseURL, "pican-test", "generated-secret", nil, timeout)
	if err != nil {
		t.Fatal(err)
	}
	return client
}
