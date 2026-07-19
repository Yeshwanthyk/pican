package codex

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"pi-web/internal/sessions"
)

var projectionLocks sync.Map

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
	ApprovalPolicy json.RawMessage
	Sandbox        json.RawMessage
}

// ReadProjectionMetadata validates that path is a Codex-owned projection.
func ReadProjectionMetadata(path string) (ProjectionMetadata, error) {
	if filepath.Base(path) != filepath.Clean(filepath.Base(path)) || !strings.HasPrefix(filepath.Base(path), "codex-") {
		return ProjectionMetadata{}, errors.New("not a Codex projection")
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
			CodexApprovalPolicy json.RawMessage `json:"codexApprovalPolicy"`
			CodexSandbox        json.RawMessage `json:"codexSandbox"`
		}
		if err := json.Unmarshal(s.Bytes(), &entry); err != nil {
			return ProjectionMetadata{}, fmt.Errorf("decode Codex projection: %w", err)
		}
		switch entry.Type {
		case "session":
			if entry.Runtime != "codex" || entry.ModelProvider != Provider || entry.NativeID == "" || entry.CWD == "" {
				return ProjectionMetadata{}, errors.New("invalid Codex projection metadata")
			}
			metadata = ProjectionMetadata{
				NativeID:       entry.NativeID,
				CWD:            entry.CWD,
				Model:          entry.Model,
				Effort:         entry.Effort,
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
	lockAny, _ := projectionLocks.LoadOrStore(path, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	return os.Remove(path)
}

// FindProjections returns validated Codex projections below sessionsDir.
func FindProjections(sessionsDir string) (map[string]string, error) {
	out := map[string]string{}
	err := filepath.WalkDir(sessionsDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "codex-") || filepath.Ext(entry.Name()) != ".jsonl" {
			return nil
		}
		metadata, err := ReadProjectionMetadata(path)
		if err == nil {
			out[metadata.NativeID] = path
		}
		return nil
	})
	return out, err
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

// LabelSessionEntry serializes local labels with Materialize so an atomic
// projection refresh cannot race and discard the append.
func RenameProjection(path, name string, now func() time.Time) error {
	lockAny, _ := projectionLocks.LoadOrStore(path, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	if _, err := ReadProjectionMetadata(path); err != nil {
		return err
	}
	return sessions.RenameSession(path, name, now)
}

func AutoTitleSession(path, name string, now func() time.Time) error {
	lockAny, _ := projectionLocks.LoadOrStore(path, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	if _, err := ReadProjectionMetadata(path); err != nil {
		return err
	}
	return sessions.AutoTitleSession(path, name, now)
}

func LabelSessionEntry(path, targetID, label string, now func() time.Time) error {
	lockAny, _ := projectionLocks.LoadOrStore(path, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	if _, err := ReadProjectionMetadata(path); err != nil {
		return err
	}
	return sessions.LabelSessionEntry(path, targetID, label, now)
}

// ProjectionPath returns the only path Materialize may write for thread.
func ProjectionPath(sessionsDir string, thread Thread) (string, error) {
	if thread.ID == "" || thread.CWD == "" {
		return "", errors.New("codex thread requires id and cwd")
	}
	if strings.ContainsAny(thread.ID, "/\\") || thread.ID == "." || thread.ID == ".." {
		return "", fmt.Errorf("unsafe codex thread id %q", thread.ID)
	}
	cwd := canonicalProjectPath(thread.CWD)
	return filepath.Join(sessionsDir, sessions.EncodeProjectName(cwd), "codex-"+thread.ID+".jsonl"), nil
}

func canonicalProjectPath(path string) string {
	absolute, err := filepath.Abs(path)
	if err == nil {
		path = absolute
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	return filepath.Clean(path)
}

// Materialize atomically replaces a Codex projection while preserving local
// session_info, label, model_change, and thinking_level_change entries.
func Materialize(sessionsDir string, thread Thread) (Projection, error) {
	path, err := ProjectionPath(sessionsDir, thread)
	if err != nil {
		return Projection{}, err
	}
	thread.CWD = canonicalProjectPath(thread.CWD)
	lockAny, _ := projectionLocks.LoadOrStore(path, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()

	paths, err := projectionPaths(sessionsDir, path, thread.ID)
	if err != nil {
		return Projection{}, err
	}
	// thread/read does not include the active model or reasoning effort. Keep
	// the last projected values unless an open/start response supplied newer
	// ones, otherwise periodic catalog refreshes erase worker settings.
	for _, candidate := range paths {
		metadata, metadataErr := ReadProjectionMetadata(candidate)
		if metadataErr != nil {
			continue
		}
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
	preserved, err := readLocalEntriesFrom(paths)
	if err != nil {
		return Projection{}, fmt.Errorf("preserve local Codex projection entries: %w", err)
	}
	capturedTurns, err := readCapturedToolTurns(paths)
	if err != nil {
		return Projection{}, fmt.Errorf("preserve captured Codex tool activity: %w", err)
	}
	thread = mergeCapturedToolTurns(thread, capturedTurns)
	entries := projectThread(thread)
	entries = append(entries, preserved...)
	if err := writeJSONLAtomic(path, entries); err != nil {
		return Projection{}, err
	}
	for _, duplicate := range paths {
		if duplicate != path {
			if err := os.Remove(duplicate); err != nil && !errors.Is(err, os.ErrNotExist) {
				return Projection{}, fmt.Errorf("remove duplicate Codex projection: %w", err)
			}
		}
	}
	return Projection{ID: filepath.Base(path), Path: path, NativeID: thread.ID}, nil
}

func projectionPaths(sessionsDir, target, nativeID string) ([]string, error) {
	projects, err := os.ReadDir(sessionsDir)
	if err != nil {
		return nil, err
	}
	paths := make([]string, 0, 1)
	if _, err := os.Stat(target); err == nil {
		paths = append(paths, target)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		candidate := filepath.Join(sessionsDir, project.Name(), filepath.Base(target))
		if candidate == target {
			continue
		}
		metadata, err := ReadProjectionMetadata(candidate)
		if err == nil && metadata.NativeID == nativeID {
			paths = append(paths, candidate)
		}
	}
	return paths, nil
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
	created := unixTimestamp(thread.CreatedAt)
	title := strings.TrimSpace(thread.Name)
	if title == "" {
		title = strings.TrimSpace(thread.Preview)
	}
	header := map[string]any{"type": "session", "version": 3, "id": "codex-" + thread.ID, "timestamp": created, "cwd": thread.CWD, "runtime": "codex", "nativeId": thread.ID, "name": title, "preview": thread.Preview, "provider": Provider, "modelProvider": Provider}
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

func readLocalEntriesFrom(paths []string) ([]map[string]any, error) {
	var out []map[string]any
	seen := map[string]struct{}{}
	for _, path := range paths {
		entries, err := readLocalEntries(path)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			key, _ := entry["id"].(string)
			if key == "" {
				encoded, err := json.Marshal(entry)
				if err != nil {
					return nil, err
				}
				key = string(encoded)
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, entry)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		left, _ := out[i]["timestamp"].(string)
		right, _ := out[j]["timestamp"].(string)
		return left < right
	})
	return out, nil
}

func readLocalEntries(path string) ([]map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []map[string]any
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 64<<10), maxLineBytes)
	line := 0
	for s.Scan() {
		line++
		var e map[string]any
		if err := json.Unmarshal(s.Bytes(), &e); err != nil {
			return nil, fmt.Errorf("decode projection line %d: %w", line, err)
		}
		switch e["type"] {
		case "session_info", "label", "model_change", "thinking_level_change":
			out = append(out, e)
		}
	}
	return out, s.Err()
}
func writeJSONLAtomic(path string, entries []map[string]any) error {
	var data bytes.Buffer
	for _, e := range entries {
		if err := json.NewEncoder(&data).Encode(e); err != nil {
			return err
		}
	}
	if current, err := os.ReadFile(path); err == nil && bytes.Equal(current, data.Bytes()) {
		return nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".codex-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		_ = f.Close()
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if _, err = f.Write(data.Bytes()); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	err = dir.Sync()
	closeErr := dir.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	ok = true
	return nil
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
