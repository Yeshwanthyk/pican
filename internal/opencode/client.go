package opencode

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

const (
	maxErrorBodyBytes = 8 << 10
	maxSSEEventBytes  = 4 << 20
)

type APIError struct {
	StatusCode int
	Method     string
	Path       string
	Body       string
}

func (e *APIError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("OpenCode %s %s returned HTTP %d", e.Method, e.Path, e.StatusCode)
	}
	return fmt.Sprintf("OpenCode %s %s returned HTTP %d: %s", e.Method, e.Path, e.StatusCode, e.Body)
}

type basicAuthTransport struct {
	base     http.RoundTripper
	origin   string
	username string
	password string
}

func (t *basicAuthTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Scheme+"://"+request.URL.Host != t.origin {
		return nil, errors.New("refusing to send OpenCode credentials outside the configured loopback origin")
	}
	clone := request.Clone(request.Context())
	clone.Header = request.Header.Clone()
	clone.SetBasicAuth(t.username, t.password)
	return t.base.RoundTrip(clone)
}

type Client struct {
	baseURL    *url.URL
	http       *http.Client
	streamHTTP *http.Client
}

// NewClient constructs a generated-Basic-Auth client and rejects non-loopback
// origins so credentials cannot be redirected to a remote child service.
func NewClient(baseURL, username, password string, baseTransport http.RoundTripper, timeout time.Duration) (*Client, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("parse OpenCode URL: %w", err)
	}
	if parsed.Scheme != "http" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("OpenCode URL must be a bare loopback http origin")
	}
	host := parsed.Hostname()
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, errors.New("OpenCode URL must use a loopback IP address")
	}
	if parsed.Port() == "" {
		return nil, errors.New("OpenCode URL must include a port")
	}
	if username == "" || password == "" {
		return nil, errors.New("OpenCode Basic Auth credentials are required")
	}
	if baseTransport == nil {
		baseTransport = http.DefaultTransport
	}
	transport := &basicAuthTransport{
		base:     baseTransport,
		origin:   parsed.Scheme + "://" + parsed.Host,
		username: username,
		password: password,
	}
	return &Client{
		baseURL: parsed,
		http:    &http.Client{Transport: transport, Timeout: timeout},
		// A process-wide SSE subscription is expected to outlive the timeout
		// used to bound ordinary API calls. Its context is the only lifetime
		// bound; inheriting http.Client.Timeout here tears down a healthy
		// runtime periodically.
		streamHTTP: &http.Client{Transport: transport},
	}, nil
}

func (c *Client) Health(ctx context.Context) (Health, error) {
	var response Health
	err := c.doJSON(ctx, http.MethodGet, "/global/health", "", nil, &response)
	return response, err
}

func (c *Client) Providers(ctx context.Context, directory string) (ProviderResponse, error) {
	var response ProviderResponse
	err := c.doJSON(ctx, http.MethodGet, "/provider", directory, nil, &response)
	return response, err
}

func (c *Client) ListSessions(ctx context.Context, directory string) ([]Session, error) {
	var response []Session
	err := c.doJSON(ctx, http.MethodGet, "/session", directory, nil, &response)
	return response, err
}

func (c *Client) GetSession(ctx context.Context, sessionID, directory string) (Session, error) {
	var response Session
	err := c.doJSON(ctx, http.MethodGet, sessionPath(sessionID), directory, nil, &response)
	return response, err
}

func (c *Client) CreateSession(ctx context.Context, directory string, request CreateSessionRequest) (Session, error) {
	var response Session
	err := c.doJSON(ctx, http.MethodPost, "/session", directory, request, &response)
	return response, err
}

func (c *Client) UpdateSession(ctx context.Context, sessionID, directory string, request UpdateSessionRequest) (Session, error) {
	var response Session
	err := c.doJSON(ctx, http.MethodPatch, sessionPath(sessionID), directory, request, &response)
	return response, err
}

func (c *Client) DeleteSession(ctx context.Context, sessionID, directory string) (bool, error) {
	var response bool
	err := c.doJSON(ctx, http.MethodDelete, sessionPath(sessionID), directory, nil, &response)
	return response, err
}

func (c *Client) ForkSession(ctx context.Context, sessionID, directory string, request ForkSessionRequest) (Session, error) {
	var response Session
	err := c.doJSON(ctx, http.MethodPost, sessionPath(sessionID)+"/fork", directory, request, &response)
	return response, err
}

func (c *Client) Messages(ctx context.Context, sessionID, directory string) ([]Message, error) {
	var response []Message
	err := c.doJSON(ctx, http.MethodGet, sessionPath(sessionID)+"/message", directory, nil, &response)
	return response, err
}

func (c *Client) Children(ctx context.Context, sessionID, directory string) ([]Session, error) {
	var response []Session
	err := c.doJSON(ctx, http.MethodGet, sessionPath(sessionID)+"/children", directory, nil, &response)
	return response, err
}

func (c *Client) Status(ctx context.Context, directory string) (map[string]SessionStatus, error) {
	var response map[string]SessionStatus
	err := c.doJSON(ctx, http.MethodGet, "/session/status", directory, nil, &response)
	return response, err
}

func (c *Client) Commands(ctx context.Context, directory string) ([]NativeCommand, error) {
	var response []NativeCommand
	err := c.doJSON(ctx, http.MethodGet, "/command", directory, nil, &response)
	return response, err
}

func (c *Client) PromptAsync(ctx context.Context, sessionID, directory string, request PromptRequest) error {
	return c.doJSON(ctx, http.MethodPost, sessionPath(sessionID)+"/prompt_async", directory, request, nil)
}

func (c *Client) Abort(ctx context.Context, sessionID, directory string) (bool, error) {
	var response bool
	err := c.doJSON(ctx, http.MethodPost, sessionPath(sessionID)+"/abort", directory, nil, &response)
	return response, err
}

func (c *Client) StreamEvents(ctx context.Context, onEvent func(Event)) error {
	return c.streamEvents(ctx, nil, onEvent)
}

// streamEvents reports readiness only after the server has accepted the
// authenticated request and returned an SSE response. Supervisor recovery
// uses that boundary to establish the mutation stream before reconciling
// native state.
func (c *Client) streamEvents(ctx context.Context, onReady func(), onEvent func(Event)) error {
	request, err := c.newRequest(ctx, http.MethodGet, "/global/event", "", nil)
	if err != nil {
		return err
	}
	response, err := c.streamHTTP.Do(request)
	if err != nil {
		return fmt.Errorf("connect OpenCode event stream: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return apiError(response, request.Method)
	}
	if !strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		return fmt.Errorf("OpenCode event stream returned content type %q", response.Header.Get("Content-Type"))
	}
	if onReady != nil {
		onReady()
	}

	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64<<10), maxSSEEventBytes)
	var data bytes.Buffer
	flush := func() error {
		if data.Len() == 0 {
			return nil
		}
		var event Event
		if err := json.Unmarshal(data.Bytes(), &event); err != nil {
			return fmt.Errorf("decode OpenCode event: %w", err)
		}
		data.Reset()
		if onEvent != nil {
			onEvent(event)
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read OpenCode event stream: %w", err)
	}
	if err := flush(); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return io.ErrUnexpectedEOF
}

func sessionPath(sessionID string) string {
	return "/session/" + url.PathEscape(sessionID)
}

func (c *Client) doJSON(ctx context.Context, method, requestPath, directory string, body, target any) error {
	request, err := c.newRequest(ctx, method, requestPath, directory, body)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("OpenCode %s %s: %w", method, requestPath, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return apiError(response, method)
	}
	if target == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 32<<20))
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode OpenCode %s %s response: %w", method, requestPath, err)
	}
	return nil
}

func (c *Client) newRequest(ctx context.Context, method, requestPath, directory string, body any) (*http.Request, error) {
	endpoint := *c.baseURL
	endpoint.Path = path.Join(endpoint.Path, requestPath)
	if directory != "" {
		query := endpoint.Query()
		query.Set("directory", directory)
		endpoint.RawQuery = query.Encode()
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode OpenCode %s %s request: %w", method, requestPath, err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if requestPath == "/global/event" {
		request.Header.Set("Accept", "text/event-stream")
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return request, nil
}

func apiError(response *http.Response, method string) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBodyBytes+1))
	if len(body) > maxErrorBodyBytes {
		body = append(body[:maxErrorBodyBytes], []byte("…")...)
	}
	return &APIError{
		StatusCode: response.StatusCode,
		Method:     method,
		Path:       response.Request.URL.Path,
		Body:       strings.TrimSpace(string(body)),
	}
}
