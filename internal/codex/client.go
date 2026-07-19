package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxLineBytes = 32 << 20
	maxStderr    = 64 << 10
)

var ErrClosed = errors.New("codex app-server client closed")

type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("codex rpc error %d: %s", e.Code, e.Message) }

type Notification struct {
	Method string
	Params json.RawMessage
}
type NotificationHandler func(Notification)

type pendingResult struct {
	result json.RawMessage
	err    error
}

// Client is a concurrent JSONL JSON-RPC client for one app-server process.
// Request IDs are integers. Command is argv, never a shell string.
type Client struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	seq        atomic.Int64
	writeMu    sync.Mutex
	mu         sync.Mutex
	pending    map[int64]chan pendingResult
	done       chan struct{}
	waitDone   chan struct{}
	closeOnce  sync.Once
	err        error
	stderr     *boundedBuffer
	handler    NotificationHandler
	notifyMu   sync.Mutex
	notifyQ    []Notification
	notifyWake chan struct{}
}

// NewClient launches command (default: codex app-server --stdio), initializes
// the protocol, and sends initialized. The current environment, including
// HOME, is inherited unchanged.
func NewClient(ctx context.Context, command []string, handler NotificationHandler) (*Client, error) {
	if len(command) == 0 {
		command = []string{"codex", "app-server", "--stdio"}
	}
	cmd := exec.Command(command[0], command[1:]...)
	configureCommand(cmd)
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &boundedBuffer{max: maxStderr}
	cmd.Stderr = stderr
	c := &Client{
		cmd:        cmd,
		stdin:      stdin,
		pending:    make(map[int64]chan pendingResult),
		done:       make(chan struct{}),
		waitDone:   make(chan struct{}),
		stderr:     stderr,
		handler:    handler,
		notifyWake: make(chan struct{}, 1),
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start codex app-server: %w", err)
	}
	go c.consume(stdout)
	if handler != nil {
		go c.dispatchNotifications()
	}
	go func() {
		err := cmd.Wait()
		close(c.waitDone)
		c.fail(c.processError(err))
	}()
	var initialized json.RawMessage
	if err := c.Call(ctx, "initialize", map[string]any{"clientInfo": map[string]any{"name": "pican", "title": "pican", "version": "0.1"}, "capabilities": map[string]any{"experimentalApi": false}}, &initialized); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("initialize codex app-server: %w", err)
	}
	if err := c.NotifyNoParams("initialized"); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *Client) PID() int {
	if c.cmd != nil && c.cmd.Process != nil {
		return c.cmd.Process.Pid
	}
	return 0
}

func (c *Client) processError(err error) error {
	if err == nil {
		return fmt.Errorf("codex app-server exited: %w", io.EOF)
	}
	msg := strings.TrimSpace(c.stderr.String())
	if msg != "" {
		return fmt.Errorf("codex app-server exited: %w: %s", err, msg)
	}
	return fmt.Errorf("codex app-server exited: %w", err)
}

func (c *Client) consume(r io.Reader) {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 64<<10), maxLineBytes)
	for s.Scan() {
		line := bytes.TrimSpace(s.Bytes())
		if len(line) == 0 {
			continue
		}
		if err := c.route(append([]byte(nil), line...)); err != nil {
			c.fail(err)
			return
		}
	}
	if err := s.Err(); err != nil {
		c.fail(fmt.Errorf("codex stdout: %w", err))
		return
	}
	// Wait normally reports the more useful exit status. A child that closes
	// stdout but stays alive still transitions the client to failed shortly.
	go func() {
		timer := time.NewTimer(50 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
			c.fail(fmt.Errorf("codex stdout closed: %w", io.EOF))
		case <-c.done:
		}
	}()
}

func (c *Client) route(line []byte) error {
	var env struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(line, &env); err != nil {
		return fmt.Errorf("invalid codex JSON-RPC line: %w", err)
	}
	if env.Method != "" {
		if len(env.ID) != 0 && string(env.ID) != "null" {
			if !validRequestID(env.ID) {
				return errors.New("invalid Codex server request id")
			}
			return c.answerServerRequest(env.ID, env.Method)
		}
		if c.handler != nil {
			c.enqueueNotification(Notification{Method: env.Method, Params: append(json.RawMessage(nil), env.Params...)})
		}
		return nil
	}
	if len(env.ID) == 0 || !validRequestID(env.ID) {
		return errors.New("invalid codex JSON-RPC envelope")
	}
	var id int64
	if err := json.Unmarshal(env.ID, &id); err != nil {
		// Outbound requests always use integer IDs. A response with a string ID
		// cannot belong to this client and is safely ignored.
		return nil
	}
	c.mu.Lock()
	ch := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if ch == nil {
		return nil
	}
	if len(env.Error) != 0 && string(env.Error) != "null" {
		var rpcErr RPCError
		if err := json.Unmarshal(env.Error, &rpcErr); err != nil {
			return fmt.Errorf("invalid Codex JSON-RPC error: %w", err)
		}
		ch <- pendingResult{err: &rpcErr}
		return nil
	}
	if len(env.Result) == 0 {
		return errors.New("invalid Codex JSON-RPC response without result or error")
	}
	ch <- pendingResult{result: env.Result}
	return nil
}

func validRequestID(id json.RawMessage) bool {
	var integer int64
	if json.Unmarshal(id, &integer) == nil {
		return true
	}
	var text string
	return json.Unmarshal(id, &text) == nil
}

func (c *Client) answerServerRequest(id json.RawMessage, method string) error {
	var result any
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		result = map[string]any{"decision": "decline"}
	case "execCommandApproval", "applyPatchApproval":
		result = map[string]any{"decision": "denied"}
	case "item/permissions/requestApproval":
		result = map[string]any{"permissions": map[string]any{}}
	case "item/tool/requestUserInput":
		result = map[string]any{"answers": map[string]any{}}
	case "mcpServer/elicitation/request":
		result = map[string]any{"action": "decline"}
	default:
		return c.write(map[string]any{"id": id, "error": map[string]any{"code": -32601, "message": "Method not found"}})
	}
	return c.write(map[string]any{"id": id, "result": result})
}

// Notifications are delivered in wire order outside the stdout reader. This
// allows a handler to issue a synchronous Call without deadlocking response
// routing behind itself.
func (c *Client) enqueueNotification(notification Notification) {
	c.notifyMu.Lock()
	c.notifyQ = append(c.notifyQ, notification)
	c.notifyMu.Unlock()
	select {
	case c.notifyWake <- struct{}{}:
	default:
	}
}

func (c *Client) dispatchNotifications() {
	for {
		select {
		case <-c.notifyWake:
			for {
				c.notifyMu.Lock()
				if len(c.notifyQ) == 0 {
					c.notifyMu.Unlock()
					break
				}
				notification := c.notifyQ[0]
				c.notifyQ[0] = Notification{}
				c.notifyQ = c.notifyQ[1:]
				c.notifyMu.Unlock()
				c.handler(notification)
			}
		case <-c.done:
			return
		}
	}
}

// Call sends a request and decodes its result. Cancellation removes only this
// pending request; late responses are safely discarded.
func (c *Client) Call(ctx context.Context, method string, params any, out any) error {
	id := c.seq.Add(1)
	ch := make(chan pendingResult, 1)
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return err
	}
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		c.remove(id)
		return err
	}
	select {
	case got := <-ch:
		if got.err != nil {
			return got.err
		}
		if out == nil {
			return nil
		}
		if err := json.Unmarshal(got.result, out); err != nil {
			return fmt.Errorf("decode %s response: %w", method, err)
		}
		return nil
	case <-ctx.Done():
		c.remove(id)
		return ctx.Err()
	case <-c.done:
		c.mu.Lock()
		err := c.err
		c.mu.Unlock()
		if err == nil {
			err = ErrClosed
		}
		return err
	}
}

func (c *Client) Notify(method string, params any) error {
	return c.write(map[string]any{"method": method, "params": params})
}
func (c *Client) NotifyNoParams(method string) error {
	return c.write(map[string]any{"method": method})
}
func (c *Client) write(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	closed := c.err
	c.mu.Unlock()
	if closed != nil {
		return closed
	}
	_, err = c.stdin.Write(data)
	if err != nil {
		c.fail(err)
	}
	return err
}
func (c *Client) remove(id int64) { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }
func (c *Client) fail(err error) {
	if err == nil {
		err = ErrClosed
	}
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.err = err
		pending := c.pending
		c.pending = make(map[int64]chan pendingResult)
		c.mu.Unlock()
		close(c.done)
		for _, ch := range pending {
			ch <- pendingResult{err: err}
		}
	})
}

// Close closes stdin and terminates only this client's child process.
func (c *Client) Close() error {
	c.fail(ErrClosed)
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	if c.cmd != nil && c.cmd.Process != nil {
		if err := killCommand(c.cmd); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return err
		}
	}
	if c.waitDone != nil {
		<-c.waitDone
	}
	return nil
}

type boundedBuffer struct {
	mu  sync.Mutex
	b   []byte
	max int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.b = append(b.b, p...)
	if len(b.b) > b.max {
		b.b = append([]byte(nil), b.b[len(b.b)-b.max:]...)
	}
	return len(p), nil
}
func (b *boundedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return string(b.b) }
