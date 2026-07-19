package codex

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
)

var ErrRepeatedCursor = errors.New("codex pagination repeated cursor")

var VisibleSourceKinds = []string{"cli", "vscode", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"}

type ThreadListOptions struct {
	CWD            string
	Archived       bool
	SearchTerm     string
	Limit          uint32
	MaximumPages   int
	UseStateDBOnly bool
}

// ListThreads walks all pages and rejects repeated cursors.
func (c *Client) ListThreads(ctx context.Context, opts ThreadListOptions) ([]Thread, error) {
	if opts.Limit == 0 {
		opts.Limit = 100
	}
	if opts.MaximumPages == 0 {
		opts.MaximumPages = 100
	}
	var out []Thread
	cursor := ""
	seen := map[string]bool{}
	for page := 0; page < opts.MaximumPages; page++ {
		params := map[string]any{"limit": opts.Limit, "archived": opts.Archived, "sourceKinds": VisibleSourceKinds, "sortKey": "updated_at", "sortDirection": "desc", "useStateDbOnly": opts.UseStateDBOnly}
		if cursor != "" {
			params["cursor"] = cursor
		}
		if opts.CWD != "" {
			params["cwd"] = opts.CWD
		}
		if opts.SearchTerm != "" {
			params["searchTerm"] = opts.SearchTerm
		}
		var response struct {
			Data       []Thread `json:"data"`
			NextCursor *string  `json:"nextCursor"`
		}
		if err := c.Call(ctx, "thread/list", params, &response); err != nil {
			return nil, err
		}
		out = append(out, response.Data...)
		if response.NextCursor == nil || *response.NextCursor == "" {
			return out, nil
		}
		if seen[*response.NextCursor] {
			return nil, fmt.Errorf("%w: %s", ErrRepeatedCursor, *response.NextCursor)
		}
		seen[*response.NextCursor] = true
		cursor = *response.NextCursor
	}
	return nil, fmt.Errorf("codex thread pagination exceeded %d pages", opts.MaximumPages)
}

func (c *Client) ReadThread(ctx context.Context, id string) (Thread, error) {
	var r struct {
		Thread Thread `json:"thread"`
	}
	err := c.Call(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": true}, &r)
	return r.Thread, err
}

const (
	approvalPolicyNever     = "never"
	sandboxDangerFullAccess = "danger-full-access"
)

func (c *Client) StartThread(ctx context.Context, cwd, model, effort string) (Thread, error) {
	p := map[string]any{"cwd": cwd, "approvalPolicy": approvalPolicyNever, "sandbox": sandboxDangerFullAccess}
	if model != "" {
		p["model"] = model
	}
	if effort != "" {
		p["config"] = map[string]any{"model_reasoning_effort": effort}
	}
	var r threadOpenResponse
	err := c.Call(ctx, "thread/start", p, &r)
	thread := r.thread(model)
	if thread.Effort == "" {
		thread.Effort = effort
	}
	return thread, err
}
func (c *Client) ResumeThread(ctx context.Context, id, cwd, model string) (Thread, error) {
	p := map[string]any{"threadId": id, "cwd": cwd, "approvalPolicy": approvalPolicyNever, "sandbox": sandboxDangerFullAccess}
	if model != "" {
		p["model"] = model
	}
	var r threadOpenResponse
	err := c.Call(ctx, "thread/resume", p, &r)
	return r.thread(model), err
}

type threadOpenResponse struct {
	Thread          Thread          `json:"thread"`
	CWD             string          `json:"cwd"`
	Model           string          `json:"model"`
	ModelProvider   string          `json:"modelProvider"`
	ReasoningEffort string          `json:"reasoningEffort"`
	ApprovalPolicy  json.RawMessage `json:"approvalPolicy"`
	Sandbox         json.RawMessage `json:"sandbox"`
}

func (r threadOpenResponse) thread(fallbackModel string) Thread {
	r.Thread.CWD = r.CWD
	r.Thread.Model = r.Model
	if r.Thread.Model == "" {
		r.Thread.Model = fallbackModel
	}
	r.Thread.ModelProvider = r.ModelProvider
	r.Thread.Effort = r.ReasoningEffort
	r.Thread.ApprovalPolicy = append(json.RawMessage(nil), r.ApprovalPolicy...)
	r.Thread.Sandbox = append(json.RawMessage(nil), r.Sandbox...)
	return r.Thread
}
func (c *Client) ForkThread(ctx context.Context, id string, lastTurnID *string) (Thread, error) {
	p := map[string]any{"threadId": id, "approvalPolicy": approvalPolicyNever, "sandbox": sandboxDangerFullAccess}
	if lastTurnID != nil && *lastTurnID != "" {
		p["lastTurnId"] = *lastTurnID
	}
	var r threadOpenResponse
	err := c.Call(ctx, "thread/fork", p, &r)
	return r.thread(""), err
}
func (c *Client) SetThreadName(ctx context.Context, id, name string) error {
	return c.Call(ctx, "thread/name/set", map[string]any{"threadId": id, "name": name}, nil)
}

var clientMessageSequence atomic.Uint64

func clientMessageID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("pican-fallback-%d", clientMessageSequence.Add(1))
	}
	return "pican-" + hex.EncodeToString(b[:])
}

func (c *Client) StartTurn(ctx context.Context, threadID string, input []UserInput, cwd, model, effort string) (Turn, error) {
	p := map[string]any{
		"threadId":            threadID,
		"input":               input,
		"clientUserMessageId": clientMessageID(),
		"approvalPolicy":      approvalPolicyNever,
		"sandboxPolicy":       map[string]any{"type": "dangerFullAccess"},
	}
	if cwd != "" {
		p["cwd"] = cwd
	}
	if model != "" {
		p["model"] = model
	}
	if effort != "" {
		p["effort"] = effort
	}
	var r struct {
		Turn Turn `json:"turn"`
	}
	err := c.Call(ctx, "turn/start", p, &r)
	return r.Turn, err
}
func (c *Client) SteerTurn(ctx context.Context, threadID, turnID string, input []UserInput) (string, error) {
	var r struct {
		TurnID string `json:"turnId"`
	}
	err := c.Call(ctx, "turn/steer", map[string]any{"threadId": threadID, "expectedTurnId": turnID, "input": input, "clientUserMessageId": clientMessageID()}, &r)
	return r.TurnID, err
}
func (c *Client) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	return c.Call(ctx, "turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID}, nil)
}
func (c *Client) StartCompact(ctx context.Context, threadID string) error {
	return c.Call(ctx, "thread/compact/start", map[string]any{"threadId": threadID}, nil)
}

type ReviewStartResult struct {
	ReviewThreadID string `json:"reviewThreadId"`
	Turn           Turn   `json:"turn"`
}

func (c *Client) StartReview(ctx context.Context, threadID string) (ReviewStartResult, error) {
	var r ReviewStartResult
	err := c.Call(ctx, "review/start", map[string]any{"threadId": threadID, "target": map[string]any{"type": "uncommittedChanges"}}, &r)
	return r, err
}

func (c *Client) ArchiveThread(ctx context.Context, threadID string) error {
	return c.Call(ctx, "thread/archive", map[string]any{"threadId": threadID}, nil)
}
func (c *Client) UnarchiveThread(ctx context.Context, threadID string) error {
	return c.Call(ctx, "thread/unarchive", map[string]any{"threadId": threadID}, nil)
}
func (c *Client) DeleteThread(ctx context.Context, threadID string) error {
	return c.Call(ctx, "thread/delete", map[string]any{"threadId": threadID}, nil)
}

// ListModels walks model/list with the same cursor-loop guard.
func (c *Client) ListModels(ctx context.Context, includeHidden bool) ([]Model, error) {
	var out []Model
	cursor := ""
	seen := map[string]bool{}
	for page := 0; page < 100; page++ {
		p := map[string]any{"includeHidden": includeHidden, "limit": 100}
		if cursor != "" {
			p["cursor"] = cursor
		}
		var r struct {
			Data       []Model `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if err := c.Call(ctx, "model/list", p, &r); err != nil {
			return nil, err
		}
		out = append(out, r.Data...)
		if r.NextCursor == nil || *r.NextCursor == "" {
			return out, nil
		}
		if seen[*r.NextCursor] {
			return nil, fmt.Errorf("%w: %s", ErrRepeatedCursor, *r.NextCursor)
		}
		seen[*r.NextCursor] = true
		cursor = *r.NextCursor
	}
	return nil, errors.New("codex model pagination exceeded 100 pages")
}
