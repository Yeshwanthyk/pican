package codex

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pican/internal/projections"
	"pican/internal/sessions"
)

var ErrNoTurnBoundary = errors.New("Codex entry has no turn boundary")

// Projection identifies a materialized pican session.
type Projection struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	NativeID string `json:"nativeId"`
}

// ProjectionMetadata is the trusted session-header subset used to select the
// Codex runtime without relying on a filename prefix alone.
type ProjectionMetadata struct {
	NativeID       string
	CWD            string
	Model          string
	Effort         string
	Fresh          bool
	ApprovalPolicy json.RawMessage
	Sandbox        json.RawMessage
}

// ReadProjectionMetadata validates that path is a Codex-owned projection.
func ReadProjectionMetadata(path string) (ProjectionMetadata, error) {
	if filepath.Base(path) != filepath.Clean(filepath.Base(path)) || !strings.HasPrefix(filepath.Base(path), "codex-") {
		return ProjectionMetadata{}, errors.New("not a Codex projection")
	}
	store, err := projectionStoreForPath(path)
	if err != nil {
		return ProjectionMetadata{}, err
	}
	identity, err := store.ReadMetadata(path)
	if err != nil {
		return ProjectionMetadata{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return ProjectionMetadata{}, err
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 64<<10), maxLineBytes)
	var metadata ProjectionMetadata
	for s.Scan() {
		var entry struct {
			Type                string          `json:"type"`
			Runtime             string          `json:"runtime"`
			NativeID            string          `json:"nativeId"`
			CWD                 string          `json:"cwd"`
			Model               string          `json:"model"`
			ModelProvider       string          `json:"modelProvider"`
			Effort              string          `json:"effort"`
			ModelID             string          `json:"modelId"`
			ThinkingLevel       string          `json:"thinkingLevel"`
			Fresh               bool            `json:"codexFresh"`
			CodexApprovalPolicy json.RawMessage `json:"codexApprovalPolicy"`
			CodexSandbox        json.RawMessage `json:"codexSandbox"`
		}
		if err := json.Unmarshal(s.Bytes(), &entry); err != nil {
			return ProjectionMetadata{}, fmt.Errorf("decode Codex projection: %w", err)
		}
		switch entry.Type {
		case "session":
			if entry.Runtime != identity.Runtime || entry.ModelProvider != Provider || entry.NativeID != identity.NativeID || entry.CWD != identity.CWD {
				return ProjectionMetadata{}, errors.New("invalid Codex projection metadata")
			}
			metadata = ProjectionMetadata{
				NativeID:       entry.NativeID,
				CWD:            entry.CWD,
				Model:          entry.Model,
				Effort:         entry.Effort,
				Fresh:          entry.Fresh,
				ApprovalPolicy: append(json.RawMessage(nil), entry.CodexApprovalPolicy...),
				Sandbox:        append(json.RawMessage(nil), entry.CodexSandbox...),
			}
		case "model_change":
			metadata.Model = entry.ModelID
		case "thinking_level_change":
			metadata.Effort = entry.ThinkingLevel
		}
	}
	if err := s.Err(); err != nil {
		return ProjectionMetadata{}, err
	}
	if metadata.NativeID == "" {
		return ProjectionMetadata{}, errors.New("invalid Codex projection metadata")
	}
	return metadata, nil
}

// RemoveProjection removes only a validated Codex cache projection.
func RemoveProjection(path, nativeID string) error {
	metadata, err := ReadProjectionMetadata(path)
	if err != nil {
		return err
	}
	if nativeID == "" || metadata.NativeID != nativeID {
		return errors.New("Codex projection native id mismatch")
	}
	store, err := projectionStoreForPath(path)
	if err != nil {
		return err
	}
	return store.Remove(path, nativeID)
}

// FindProjections returns validated Codex projections below sessionsDir.
func FindProjections(sessionsDir string) (map[string]string, error) {
	store, err := projections.NewStore(sessionsDir, "codex")
	if err != nil {
		return nil, err
	}
	return store.FindValidated(func(path string, _ projections.Metadata) error {
		_, err := ReadProjectionMetadata(path)
		return err
	})
}

// ResolveTurnID maps a projected entry to its authoritative Codex turn.
func ResolveTurnID(path, entryID string) (string, error) {
	if _, err := ReadProjectionMetadata(path); err != nil {
		return "", err
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 64<<10), maxLineBytes)
	for s.Scan() {
		var entry struct {
			ID          string `json:"id"`
			CodexTurnID string `json:"codexTurnId"`
		}
		if json.Unmarshal(s.Bytes(), &entry) == nil && entry.ID == entryID {
			if entry.CodexTurnID == "" {
				return "", ErrNoTurnBoundary
			}
			return entry.CodexTurnID, nil
		}
	}
	if err := s.Err(); err != nil {
		return "", err
	}
	return "", sessions.ErrSessionEntryNotFound
}

// RenameProjection serializes local names with Materialize so an atomic
// projection refresh cannot race and discard the append.
func RenameProjection(path, name string, now func() time.Time) error {
	store, err := projectionStoreForPath(path)
	if err != nil {
		return err
	}
	return store.Rename(path, name, now)
}

func AutoTitleSession(path, name string, now func() time.Time) error {
	store, err := projectionStoreForPath(path)
	if err != nil {
		return err
	}
	return store.AutoTitle(path, name, now)
}

func LabelSessionEntry(path, targetID, label string, now func() time.Time) error {
	store, err := projectionStoreForPath(path)
	if err != nil {
		return err
	}
	return store.Label(path, targetID, label, now)
}

// ProjectionPath returns the only path Materialize may write for thread.
func ProjectionPath(sessionsDir string, thread Thread) (string, error) {
	if thread.ID == "" || thread.CWD == "" {
		return "", errors.New("codex thread requires id and cwd")
	}
	if strings.ContainsAny(thread.ID, "/\\") || thread.ID == "." || thread.ID == ".." {
		return "", fmt.Errorf("unsafe codex thread id %q", thread.ID)
	}
	store, err := projections.NewStore(sessionsDir, "codex")
	if err != nil {
		return "", err
	}
	return store.Path(thread.ID, thread.CWD)
}

func canonicalProjectPath(path string) string {
	return projections.CanonicalCWD(path)
}

func projectionStoreForPath(path string) (*projections.Store, error) {
	return projections.NewStore(filepath.Dir(filepath.Dir(path)), "codex")
}

type freshProjectionMode uint8

const (
	preserveFreshProjection freshProjectionMode = iota
	setFreshProjection
	clearFreshProjection
)

// Materialize atomically replaces a Codex projection while preserving local
// session_info, label, model_change, thinking_level_change, and fresh creation
// intent until native activity or authoritative catalog visibility clears it.
func Materialize(sessionsDir string, thread Thread) (Projection, error) {
	return materializeProjection(sessionsDir, thread, preserveFreshProjection)
}

func materializeProjection(sessionsDir string, thread Thread, freshMode freshProjectionMode) (Projection, error) {
	store, err := projections.NewStore(sessionsDir, "codex")
	if err != nil {
		return Projection{}, err
	}
	thread.CWD = canonicalProjectPath(thread.CWD)
	projection, err := store.Replace(thread.ID, thread.CWD, func(paths []string) ([]map[string]any, error) {
		fresh := false
		// thread/read does not include the active model or reasoning effort. Keep
		// the last projected values unless an open/start response supplied newer
		// ones, otherwise periodic catalog refreshes erase worker settings.
		for _, candidate := range paths {
			metadata, metadataErr := ReadProjectionMetadata(candidate)
			if metadataErr != nil {
				continue
			}
			fresh = fresh || metadata.Fresh
			if thread.Model == "" {
				thread.Model = metadata.Model
			}
			if thread.Effort == "" {
				thread.Effort = metadata.Effort
			}
			if len(thread.ApprovalPolicy) == 0 {
				thread.ApprovalPolicy = append(json.RawMessage(nil), metadata.ApprovalPolicy...)
			}
			if len(thread.Sandbox) == 0 {
				thread.Sandbox = append(json.RawMessage(nil), metadata.Sandbox...)
			}
		}
		capturedTurns, err := readCapturedToolTurns(paths)
		if err != nil {
			return nil, fmt.Errorf("preserve captured Codex tool activity: %w", err)
		}
		thread = mergeCapturedToolTurns(thread, capturedTurns)
		switch freshMode {
		case setFreshProjection:
			fresh = true
		case clearFreshProjection:
			fresh = false
		}
		if len(thread.Turns) > 0 {
			fresh = false
		}
		return projectThreadWithFresh(thread, fresh), nil
	})
	if err != nil {
		return Projection{}, err
	}
	return Projection{ID: projection.ID, Path: projection.Path, NativeID: projection.NativeID}, nil
}

type capturedToolTurn struct {
	turn    Turn
	hasTool bool
	seen    map[string]struct{}
}

func isToolItemType(itemType string) bool {
	switch itemType {
	case "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView", "sleep", "imageGeneration":
		return true
	default:
		return false
	}
}

func readCapturedToolTurns(paths []string) (map[string]Turn, error) {
	best := map[string]capturedToolTurn{}
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		turns := map[string]*capturedToolTurn{}
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 64<<10), maxLineBytes)
		for scanner.Scan() {
			var entry struct {
				TurnID   string                     `json:"codexTurnId"`
				ItemID   string                     `json:"codexItemId"`
				ItemType string                     `json:"codexItemType"`
				Raw      map[string]json.RawMessage `json:"codexRaw"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
				_ = f.Close()
				return nil, err
			}
			if entry.TurnID == "" || entry.ItemID == "" || entry.ItemType == "" {
				continue
			}
			captured := turns[entry.TurnID]
			if captured == nil {
				captured = &capturedToolTurn{turn: Turn{ID: entry.TurnID}, seen: map[string]struct{}{}}
				turns[entry.TurnID] = captured
			}
			if _, duplicate := captured.seen[entry.ItemID]; duplicate {
				continue
			}
			captured.seen[entry.ItemID] = struct{}{}
			captured.hasTool = captured.hasTool || isToolItemType(entry.ItemType)
			captured.turn.Items = append(captured.turn.Items, ThreadItem{ID: entry.ItemID, Type: entry.ItemType, Raw: cloneRawMap(entry.Raw)})
		}
		scanErr := scanner.Err()
		closeErr := f.Close()
		if scanErr != nil {
			return nil, scanErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		for turnID, captured := range turns {
			if !captured.hasTool {
				continue
			}
			if previous, ok := best[turnID]; !ok || len(captured.turn.Items) > len(previous.turn.Items) {
				best[turnID] = *captured
			}
		}
	}
	out := make(map[string]Turn, len(best))
	for turnID, captured := range best {
		out[turnID] = captured.turn
	}
	return out, nil
}

func semanticItemKey(item ThreadItem) string {
	switch item.Type {
	case "userMessage":
		return item.Type + "\x00" + userContent(item.Raw["content"])
	case "agentMessage":
		if phase := rawString(item.Raw["phase"]); phase != "" {
			return item.Type + "\x00phase\x00" + phase
		}
		return item.Type + "\x00text\x00" + rawString(item.Raw["text"])
	default:
		return item.Type + "\x00" + item.ID
	}
}

func mergeCapturedToolTurns(thread Thread, captured map[string]Turn) Thread {
	seenTurns := make(map[string]struct{}, len(thread.Turns))
	for turnIndex := range thread.Turns {
		turn := &thread.Turns[turnIndex]
		seenTurns[turn.ID] = struct{}{}
		preserved, ok := captured[turn.ID]
		if !ok {
			continue
		}
		hasNativeTool := false
		for _, item := range turn.Items {
			hasNativeTool = hasNativeTool || isToolItemType(item.Type)
		}
		if hasNativeTool {
			continue
		}
		merged := append([]ThreadItem(nil), preserved.Items...)
		semantic := make(map[string]int, len(merged))
		for index, item := range merged {
			semantic[semanticItemKey(item)] = index
		}
		for _, item := range turn.Items {
			key := semanticItemKey(item)
			if index, duplicate := semantic[key]; duplicate {
				if !isToolItemType(item.Type) {
					merged[index] = item
				}
				continue
			}
			semantic[key] = len(merged)
			merged = append(merged, item)
		}
		turn.Items = merged
	}
	for turnID, preserved := range captured {
		if _, ok := seenTurns[turnID]; !ok {
			thread.Turns = append(thread.Turns, preserved)
		}
	}
	return thread
}

func projectThread(thread Thread) []map[string]any {
	return projectThreadWithFresh(thread, false)
}

func projectThreadWithFresh(thread Thread, fresh bool) []map[string]any {
	created := unixTimestamp(thread.CreatedAt)
	title := strings.TrimSpace(thread.Name)
	if title == "" {
		title = strings.TrimSpace(thread.Preview)
	}
	header := map[string]any{"type": "session", "version": 3, "id": "codex-" + thread.ID, "timestamp": created, "cwd": thread.CWD, "runtime": "codex", "nativeId": thread.ID, "name": title, "preview": thread.Preview, "provider": Provider, "modelProvider": Provider}
	if fresh {
		header["codexFresh"] = true
	}
	if title == newSessionName {
		// StartSession assigns this system placeholder only to make an empty
		// native thread resumable. It is not a user-owned title, so mark it as
		// auto-generated and let the normal auto-titler replace it.
		header["autoTitle"] = true
	}
	if thread.Model != "" {
		header["model"] = thread.Model
	}
	if thread.Effort != "" {
		header["effort"] = thread.Effort
	}
	if len(thread.Source) > 0 {
		header["codexSource"] = json.RawMessage(thread.Source)
	}
	if thread.ModelProvider != "" {
		header["codexModelProvider"] = thread.ModelProvider
	}
	if len(thread.ApprovalPolicy) > 0 {
		header["codexApprovalPolicy"] = json.RawMessage(thread.ApprovalPolicy)
	}
	if len(thread.Sandbox) > 0 {
		header["codexSandbox"] = json.RawMessage(thread.Sandbox)
	}
	if len(thread.TokenUsage) > 0 {
		header["codexTokenUsage"] = json.RawMessage(thread.TokenUsage)
	}
	if thread.TurnDiff != "" {
		header["codexTurnDiff"] = thread.TurnDiff
	}
	entries := []map[string]any{header}
	var parent any
	for _, turn := range thread.Turns {
		for index, item := range turn.Items {
			ts := itemTimestamp(thread, turn, index)
			projected := projectItem(thread.ID, turn.ID, thread.Model, item, ts)
			for _, entry := range projected {
				entry["parentId"] = parent
				parent = entry["id"].(string)
				entries = append(entries, entry)
			}
		}
	}
	return entries
}

func projectItem(threadID, turnID, model string, item ThreadItem, timestamp string) []map[string]any {
	baseID := "codex-" + stableHash(threadID, turnID, item.ID)
	meta := map[string]any{"codexTurnId": turnID, "codexItemId": item.ID, "codexItemType": item.Type, "codexRaw": item.Raw}
	entry := func(kind, suffix string) map[string]any {
		e := map[string]any{"type": kind, "id": baseID + suffix, "timestamp": timestamp}
		for k, v := range meta {
			e[k] = v
		}
		return e
	}
	message := func(role, text string) map[string]any {
		e := entry("message", "")
		content := any(text)
		if role == "assistant" {
			content = []any{map[string]any{"type": "text", "text": text}}
		}
		msg := map[string]any{"role": role, "content": content, "provider": Provider}
		if model != "" {
			msg["model"] = model
		}
		e["message"] = msg
		return e
	}
	tool := func(name string) (map[string]any, map[string]any) {
		arguments := rawAny(item.Raw["arguments"])
		if arguments == nil {
			arguments = map[string]any{}
		}
		call := entry("message", "-call")
		call["message"] = map[string]any{
			"role":     "assistant",
			"content":  []any{map[string]any{"type": "toolCall", "id": baseID, "name": name, "arguments": arguments}},
			"provider": Provider,
			"model":    model,
		}
		result := entry("message", "-result")
		status := rawString(item.Raw["status"])
		result["message"] = map[string]any{
			"role":       "toolResult",
			"toolCallId": baseID,
			"toolName":   name,
			"content":    []any{},
			"isError":    false,
			"isRunning":  status == "inProgress" || status == "running",
		}
		return call, result
	}
	setToolResult := func(result map[string]any, output any, failed bool) {
		text, ok := output.(string)
		if !ok {
			text = compactJSON(output)
		}
		msg := result["message"].(map[string]any)
		msg["content"] = []any{map[string]any{"type": "text", "text": text}}
		msg["isError"] = failed
	}
	switch item.Type {
	case "userMessage":
		return []map[string]any{message("user", userContent(item.Raw["content"]))}
	case "agentMessage":
		return []map[string]any{message("assistant", rawString(item.Raw["text"]))}
	case "reasoning", "plan":
		e := message("assistant", reasoningText(item))
		e["message"].(map[string]any)["content"] = []any{map[string]any{"type": "thinking", "thinking": reasoningText(item)}}
		return []map[string]any{e}
	case "commandExecution":
		call, result := tool("bash")
		call["message"].(map[string]any)["content"].([]any)[0].(map[string]any)["arguments"] = map[string]any{"command": rawString(item.Raw["command"]), "cwd": rawString(item.Raw["cwd"])}
		exitCode := rawAny(item.Raw["exitCode"])
		failed := rawString(item.Raw["status"]) == "failed"
		if code, ok := exitCode.(float64); ok && code != 0 {
			failed = true
		}
		setToolResult(result, rawString(item.Raw["aggregatedOutput"]), failed)
		return []map[string]any{call, result}
	case "fileChange":
		call, result := tool("fileChange")
		call["message"].(map[string]any)["content"].([]any)[0].(map[string]any)["arguments"] = map[string]any{"changes": rawAny(item.Raw["changes"])}
		status := rawString(item.Raw["status"])
		setToolResult(result, status, status == "failed" || status == "declined")
		return []map[string]any{call, result}
	case "mcpToolCall":
		name := rawString(item.Raw["server"]) + "/" + rawString(item.Raw["tool"])
		call, result := tool(strings.Trim(name, "/"))
		hasError := len(item.Raw["error"]) > 0 && string(item.Raw["error"]) != "null"
		output := rawAny(item.Raw["result"])
		if hasError {
			output = rawAny(item.Raw["error"])
		}
		setToolResult(result, output, hasError)
		return []map[string]any{call, result}
	case "dynamicToolCall", "collabAgentToolCall":
		call, result := tool(rawString(item.Raw["tool"]))
		status := rawString(item.Raw["status"])
		setToolResult(result, firstAny(item.Raw, "contentItems", "agentsStates", "status"), status == "failed")
		return []map[string]any{call, result}
	case "subAgentActivity", "webSearch", "imageView", "sleep", "imageGeneration":
		call, result := tool(item.Type)
		call["message"].(map[string]any)["content"].([]any)[0].(map[string]any)["arguments"] = rawMapAny(item.Raw)
		setToolResult(result, firstAny(item.Raw, "result", "query", "path", "durationMs", "kind"), rawString(item.Raw["status"]) == "failed")
		return []map[string]any{call, result}
	case "enteredReviewMode", "exitedReviewMode":
		return []map[string]any{message("assistant", fmt.Sprintf("[%s] %s", item.Type, rawString(item.Raw["review"])))}
	case "contextCompaction":
		e := entry("compaction", "")
		e["summary"] = "Codex compacted the thread context"
		e["tokensBefore"] = 0
		return []map[string]any{e}
	case "hookPrompt":
		return []map[string]any{message("user", fmt.Sprint(rawAny(item.Raw["fragments"])))}
	default:
		return []map[string]any{message("assistant", fmt.Sprintf("[Unknown Codex item: %s]\n%s", item.Type, compactJSON(item.Raw)))}
	}
}

func writeJSONLAtomic(path string, entries []map[string]any) error {
	return projections.WriteJSONLAtomic(path, entries)
}
func stableHash(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte{0})
		h.Write([]byte(p))
	}
	return hex.EncodeToString(h.Sum(nil))[:24]
}
func unixTimestamp(v int64) string {
	if v <= 0 {
		return time.Unix(0, 0).UTC().Format(time.RFC3339Nano)
	}
	return time.Unix(v, 0).UTC().Format(time.RFC3339Nano)
}
func itemTimestamp(thread Thread, turn Turn, index int) string {
	base := turn.StartedAt
	if base == 0 {
		base = thread.CreatedAt
	}
	return time.Unix(base, int64(index)).UTC().Format(time.RFC3339Nano)
}
func rawString(v json.RawMessage) string { var s string; _ = json.Unmarshal(v, &s); return s }
func rawAny(v json.RawMessage) any {
	if len(v) == 0 {
		return nil
	}
	var x any
	if json.Unmarshal(v, &x) != nil {
		return string(v)
	}
	return x
}
func rawMapAny(m map[string]json.RawMessage) map[string]any {
	o := map[string]any{}
	for k, v := range m {
		if k != "id" && k != "type" {
			o[k] = rawAny(v)
		}
	}
	return o
}
func firstAny(m map[string]json.RawMessage, keys ...string) any {
	for _, k := range keys {
		if len(m[k]) > 0 {
			return rawAny(m[k])
		}
	}
	return nil
}
func userContent(v json.RawMessage) string {
	var inputs []map[string]any
	if json.Unmarshal(v, &inputs) != nil {
		return string(v)
	}
	var b strings.Builder
	for _, in := range inputs {
		if in["type"] == "text" {
			fmt.Fprint(&b, in["text"])
		} else if in["type"] == "image" {
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString("[image]")
		}
	}
	return b.String()
}
func reasoningText(i ThreadItem) string {
	if i.Type == "plan" {
		return rawString(i.Raw["text"])
	}
	var values []string
	_ = json.Unmarshal(i.Raw["summary"], &values)
	if len(values) == 0 {
		_ = json.Unmarshal(i.Raw["content"], &values)
	}
	return strings.Join(values, "\n")
}
func compactJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
