package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func helperCommand(scenario string, extra ...string) []string {
	return append([]string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", scenario}, extra...)
}

func TestCodexHelperProcess(t *testing.T) {
	if len(os.Args) < 4 || os.Args[2] != "--" {
		return
	}
	scenario := os.Args[3]
	var logPath string
	if len(os.Args) > 4 {
		logPath = os.Args[4]
	}
	s := bufio.NewScanner(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	thread := testThread()
	if scenario == "created-empty" || scenario == "list-empty-thread" {
		thread.Turns = nil
	}
	named := false
	var pendingStartID int64
	for s.Scan() {
		var request map[string]json.RawMessage
		if json.Unmarshal(s.Bytes(), &request) != nil {
			os.Exit(2)
		}
		var method string
		_ = json.Unmarshal(request["method"], &method)
		if logPath != "" && method != "" {
			f, _ := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if scenario == "wire" || scenario == "start-ack-pending" || scenario == "interrupt-no-reply" {
				fmt.Fprintln(f, s.Text())
			} else {
				fmt.Fprintln(f, method)
			}
			f.Close()
		}
		if len(request["id"]) == 0 {
			continue
		}
		var id int64
		_ = json.Unmarshal(request["id"], &id)
		reply := func(result any) { _ = enc.Encode(map[string]any{"id": id, "result": result}) }
		replyError := func(code int, message string) {
			_ = enc.Encode(map[string]any{"id": id, "error": map[string]any{"code": code, "message": message}})
		}
		switch method {
		case "initialize":
			reply(map[string]any{"userAgent": "fake"})
			if scenario == "exit" {
				os.Exit(7)
			}
		case "thread/resume", "thread/start", "thread/fork":
			var open struct {
				CWD, Model string
				Config     map[string]string `json:"config"`
			}
			_ = json.Unmarshal(request["params"], &open)
			if open.CWD == "" {
				open.CWD = thread.CWD
			}
			if open.Model == "" {
				open.Model = "gpt-5.6"
			}
			effort := open.Config["model_reasoning_effort"]
			if effort == "" {
				effort = "medium"
			}
			reply(map[string]any{"thread": thread, "cwd": open.CWD, "model": open.Model, "modelProvider": "openai", "reasoningEffort": effort, "approvalPolicy": "never", "approvalsReviewer": "user", "sandbox": map[string]any{"type": "workspaceWrite", "writableRoots": []string{}, "readOnlyAccess": map[string]any{"type": "fullAccess"}, "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false}})
		case "thread/read":
			if scenario == "unmaterialized" && !named {
				replyError(-32600, "thread is not materialized yet")
			} else {
				reply(map[string]any{"thread": thread})
			}
		case "thread/name/set":
			named = true
			thread.Name = newSessionName
			reply(map[string]any{})
		case "thread/list":
			if scenario == "pagination" {
				reply(map[string]any{"data": []Thread{}, "nextCursor": "same"})
			} else if scenario == "empty-list-wait" {
				deadline := time.Now().Add(2 * time.Second)
				for time.Now().Before(deadline) {
					if _, err := os.Stat(logPath + ".release"); err == nil {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				reply(map[string]any{"data": []Thread{}})
			} else if scenario == "empty-list" {
				reply(map[string]any{"data": []Thread{}})
			} else if scenario == "list-failure" {
				replyError(-32000, "list failed")
			} else {
				reply(map[string]any{"data": []Thread{thread}})
			}
		case "model/list":
			reply(map[string]any{"data": []Model{{ID: "gpt", Model: "gpt", DisplayName: "GPT", SupportedReasoningEfforts: []ReasoningEffort{{ReasoningEffort: "high"}}}}})
		case "turn/start", "review/start":
			turnID := "turn-live"
			if method == "review/start" {
				turnID = "turn-review"
			}
			if scenario == "start-ack-pending" && method == "turn/start" {
				pendingStartID = id
				_ = enc.Encode(map[string]any{"method": "turn/started", "params": map[string]any{"threadId": "thread-1", "turn": map[string]any{"id": turnID, "status": "inProgress", "items": []any{}}}})
				continue
			}
			reply(map[string]any{"reviewThreadId": "thread-1", "turn": map[string]any{"id": turnID, "status": "inProgress", "items": []any{}}})
			_ = enc.Encode(map[string]any{"method": "turn/started", "params": map[string]any{"threadId": "thread-1", "turn": map[string]any{"id": turnID, "status": "inProgress", "items": []any{}}}})
			_ = enc.Encode(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"threadId": "thread-1", "turnId": turnID, "itemId": "agent-live", "delta": "hello"}})
			_ = enc.Encode(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "thread-1", "turnId": turnID, "completedAtMs": 2, "item": map[string]any{"id": "agent-live", "type": "agentMessage", "text": "hello"}}})
		case "thread/archive", "thread/unarchive", "thread/delete", "thread/compact/start":
			reply(map[string]any{})
		case "turn/steer":
			reply(map[string]any{"turnId": "turn-live"})
		case "turn/interrupt":
			var params struct {
				TurnID string `json:"turnId"`
			}
			_ = json.Unmarshal(request["params"], &params)
			if scenario == "interrupt-no-reply" {
				continue
			}
			reply(map[string]any{})
			_ = enc.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "thread-1", "turn": map[string]any{"id": params.TurnID, "status": "interrupted", "items": []any{}}}})
			if pendingStartID != 0 {
				_ = enc.Encode(map[string]any{"id": pendingStartID, "result": map[string]any{"turn": map[string]any{"id": params.TurnID, "status": "interrupted", "items": []any{}}}})
				pendingStartID = 0
			}
		default:
			_ = enc.Encode(map[string]any{"id": id, "error": map[string]any{"code": -32601, "message": "unknown"}})
		}
	}
}

func TestSchemaRealisticWireIdentityAndLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	logPath := t.TempDir() + "/wire.jsonl"
	c, err := NewClient(ctx, helperCommand("wire", logPath), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	started, err := c.StartThread(ctx, "/tmp/project", "gpt-5.6", "medium")
	if err != nil {
		t.Fatal(err)
	}
	if started.CWD != "/tmp/project" || started.Model != "gpt-5.6" || started.ModelProvider != "openai" || started.Effort != "medium" || string(started.ApprovalPolicy) != `"never"` || len(started.Sandbox) == 0 {
		t.Fatalf("start metadata: %+v", started)
	}
	if _, err = c.ResumeThread(ctx, "thread-1", "/tmp/project", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = c.ForkThread(ctx, "thread-1", nil); err != nil {
		t.Fatal(err)
	}
	turn, err := c.StartTurn(ctx, "thread-1", []UserInput{TextInput("hi")}, "/tmp/project", "gpt-5.6", "medium")
	if err != nil {
		t.Fatal(err)
	}
	steered, err := c.SteerTurn(ctx, "thread-1", turn.ID, []UserInput{TextInput("more")})
	if err != nil || steered != "turn-live" {
		t.Fatalf("steer=%q err=%v", steered, err)
	}
	review, err := c.StartReview(ctx, "thread-1")
	if err != nil || review.ReviewThreadID != "thread-1" || review.Turn.ID != "turn-review" {
		t.Fatalf("review=%+v err=%v", review, err)
	}
	if err = c.ArchiveThread(ctx, "thread-1"); err != nil {
		t.Fatal(err)
	}
	if err = c.UnarchiveThread(ctx, "thread-1"); err != nil {
		t.Fatal(err)
	}
	if err = c.DeleteThread(ctx, "thread-1"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(logPath)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	seenIDs := map[string]bool{}
	for _, line := range lines {
		var env map[string]json.RawMessage
		if json.Unmarshal([]byte(line), &env) != nil {
			continue
		}
		var method string
		_ = json.Unmarshal(env["method"], &method)
		if method == "initialized" && len(env["params"]) != 0 {
			t.Fatalf("initialized carried params: %s", line)
		}
		if method == "thread/start" || method == "thread/resume" || method == "thread/fork" {
			var p struct {
				ApprovalPolicy string `json:"approvalPolicy"`
				Sandbox        string `json:"sandbox"`
			}
			_ = json.Unmarshal(env["params"], &p)
			if p.ApprovalPolicy != approvalPolicyNever || p.Sandbox != sandboxDangerFullAccess {
				t.Fatalf("thread operation is not YOLO: %s", line)
			}
		}
		if method == "turn/start" || method == "turn/steer" {
			var p struct {
				ClientUserMessageID string `json:"clientUserMessageId"`
				ApprovalPolicy      string `json:"approvalPolicy"`
				SandboxPolicy       struct {
					Type string `json:"type"`
				} `json:"sandboxPolicy"`
			}
			_ = json.Unmarshal(env["params"], &p)
			if p.ClientUserMessageID == "" || seenIDs[p.ClientUserMessageID] {
				t.Fatalf("bad client message id: %s", line)
			}
			if method == "turn/start" && (p.ApprovalPolicy != approvalPolicyNever || p.SandboxPolicy.Type != "dangerFullAccess") {
				t.Fatalf("turn operation is not YOLO: %s", line)
			}
			seenIDs[p.ClientUserMessageID] = true
		}
	}
	if len(seenIDs) != 2 {
		t.Fatalf("message ids=%v log=%s", seenIDs, data)
	}
}

func TestClientRoutesResponsesErrorsCancellationAndExit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, err := NewClient(ctx, helperCommand("normal"), nil)
	if err != nil {
		t.Fatal(err)
	}
	var thread struct {
		Thread Thread `json:"thread"`
	}
	if err := c.Call(ctx, "thread/read", map[string]any{"threadId": "thread-1"}, &thread); err != nil {
		t.Fatal(err)
	}
	if thread.Thread.ID != "thread-1" {
		t.Fatalf("wrong response: %+v", thread)
	}
	if err := c.Call(ctx, "unknown", map[string]any{}, nil); err == nil {
		t.Fatal("expected RPC error")
	} else {
		var rpcErr *RPCError
		if !errors.As(err, &rpcErr) || rpcErr.Code != -32601 {
			t.Fatalf("wrong error: %v", err)
		}
	}
	cancelled, cancelCall := context.WithCancel(context.Background())
	cancelCall()
	if err := c.Call(cancelled, "thread/read", map[string]any{}, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	_ = c.Close()

	exitClient, err := NewClient(ctx, helperCommand("exit"), nil)
	if err == nil {
		defer exitClient.Close()
		time.Sleep(20 * time.Millisecond)
		err = exitClient.Call(ctx, "thread/read", map[string]any{}, nil)
	}
	if err == nil || !strings.Contains(err.Error(), "exited") {
		t.Fatalf("expected process exit, got %v", err)
	}
}

func TestClientExplicitlyAnswersServerRequests(t *testing.T) {
	var output strings.Builder
	c := &Client{stdin: nopWriteCloser{&output}, pending: map[int64]chan pendingResult{}, done: make(chan struct{}), stderr: &boundedBuffer{max: maxStderr}}
	methods := []string{"item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "item/permissions/requestApproval", "mcpServer/elicitation/request", "execCommandApproval", "applyPatchApproval", "new/method"}
	for index, method := range methods {
		id := index + 1
		if err := c.route([]byte(fmt.Sprintf(`{"id":%d,"method":%q,"params":{}}`, id, method))); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.route([]byte(`{"id":"approval-string","method":"item/fileChange/requestApproval","params":{}}`)); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, want := range []string{`"decision":"decline"`, `"decision":"denied"`, `"answers":{}`, `"permissions":{}`, `"action":"decline"`, `"code":-32601`, `"id":"approval-string"`} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %s in %s", want, text)
		}
	}
}

func TestNotificationHandlerCanSynchronouslyCall(t *testing.T) {
	output := &lockedBuffer{}
	called := make(chan error, 1)
	var c *Client
	c = &Client{
		stdin:      output,
		pending:    map[int64]chan pendingResult{},
		done:       make(chan struct{}),
		stderr:     &boundedBuffer{max: maxStderr},
		notifyWake: make(chan struct{}, 1),
		handler: func(Notification) {
			var result struct {
				OK bool `json:"ok"`
			}
			err := c.Call(context.Background(), "thread/read", map[string]any{}, &result)
			if err == nil && !result.OK {
				err = errors.New("wrong nested call result")
			}
			called <- err
		},
	}
	go c.dispatchNotifications()
	if err := c.route([]byte(`{"method":"test/notification","params":{}}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for !strings.Contains(output.String(), `"method":"thread/read"`) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if err := c.route([]byte(`{"id":1,"result":{"ok":true}}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-called:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("notification handler deadlocked")
	}
	c.fail(ErrClosed)
}

type nopWriteCloser struct{ *strings.Builder }

func (n nopWriteCloser) Close() error { return nil }

type lockedBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}
func (b *lockedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.b.String() }
func (b *lockedBuffer) Close() error   { return nil }

func TestPaginationCursorLoopProtection(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, err := NewClient(ctx, helperCommand("pagination"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, err = c.ListThreads(ctx, ThreadListOptions{})
	if !errors.Is(err, ErrRepeatedCursor) {
		t.Fatalf("expected repeated cursor, got %v", err)
	}
}

func testThread() Thread {
	return Thread{ID: "thread-1", CWD: "/tmp/project", Name: "Codex test", Preview: "preview", CreatedAt: 1, UpdatedAt: 2, Turns: []Turn{{ID: "turn-1", Status: "completed", StartedAt: 1, CompletedAt: 2, Items: []ThreadItem{{ID: "user-1", Type: "userMessage", Raw: map[string]json.RawMessage{"content": json.RawMessage(`[{"type":"text","text":"hello"}]`)}}, {ID: "agent-1", Type: "agentMessage", Raw: map[string]json.RawMessage{"text": json.RawMessage(`"hi"`)}}}}}}
}
