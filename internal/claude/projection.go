package claude

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"pican/internal/projections"
)

const Provider = "anthropic"

type Projection struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	NativeID string `json:"nativeId"`
}

type ProjectionMetadata struct {
	NativeID string
	CWD      string
	Model    string
	Fresh    bool
}

// CreateSessionProjection records a fresh Claude session intent without
// creating or rewriting native Claude state. The first stream-json prompt owns
// native creation; the pending marker survives pican restart and is removed by
// the first authoritative transcript materialization.
func CreateSessionProjection(sessionsDir, cwd, model string) (Projection, error) {
	nativeID := uuid.NewString()
	return createSessionProjection(sessionsDir, nativeID, cwd, model, time.Now().UTC())
}

func createSessionProjection(sessionsDir, nativeID, cwd, model string, createdAt time.Time) (Projection, error) {
	store, err := projections.NewStore(sessionsDir, "claude")
	if err != nil {
		return Projection{}, err
	}
	cwd = projections.CanonicalCWD(cwd)
	projection, err := store.Replace(nativeID, cwd, func([]string) ([]map[string]any, error) {
		header := map[string]any{
			"type": "session", "version": 3, "id": "claude-" + nativeID,
			"timestamp": createdAt.Format(time.RFC3339Nano), "updatedAt": createdAt.Format(time.RFC3339Nano),
			"cwd": cwd, "runtime": "claude", "nativeId": nativeID,
			"provider": Provider, "modelProvider": Provider, "claudeFresh": true,
		}
		if model != "" {
			header["model"] = model
		}
		return []map[string]any{header}, nil
	})
	if err != nil {
		return Projection{}, err
	}
	return Projection{ID: projection.ID, Path: projection.Path, NativeID: projection.NativeID}, nil
}

func Materialize(sessionsDir string, transcript Transcript) (Projection, error) {
	store, err := projections.NewStore(sessionsDir, "claude")
	if err != nil {
		return Projection{}, err
	}
	transcript.CWD = projections.CanonicalCWD(transcript.CWD)
	projection, err := store.Replace(transcript.NativeID, transcript.CWD, func([]string) ([]map[string]any, error) {
		return projectTranscript(transcript), nil
	})
	if err != nil {
		return Projection{}, err
	}
	return Projection{ID: projection.ID, Path: projection.Path, NativeID: projection.NativeID}, nil
}

func ReadProjectionMetadata(path string) (ProjectionMetadata, error) {
	if !strings.HasPrefix(filepath.Base(path), "claude-") {
		return ProjectionMetadata{}, errors.New("not a Claude projection")
	}
	store, err := projections.NewStore(filepath.Dir(filepath.Dir(path)), "claude")
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
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), maxTranscriptLineBytes)
	for scanner.Scan() {
		var header struct {
			Type          string `json:"type"`
			Runtime       string `json:"runtime"`
			NativeID      string `json:"nativeId"`
			CWD           string `json:"cwd"`
			Provider      string `json:"provider"`
			ModelProvider string `json:"modelProvider"`
			Model         string `json:"model"`
			Fresh         bool   `json:"claudeFresh"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &header); err != nil {
			return ProjectionMetadata{}, err
		}
		if header.Type != "session" {
			continue
		}
		if header.Runtime != identity.Runtime || header.NativeID != identity.NativeID || header.CWD != identity.CWD || header.Provider != Provider || header.ModelProvider != Provider {
			return ProjectionMetadata{}, errors.New("invalid Claude projection metadata")
		}
		return ProjectionMetadata{NativeID: header.NativeID, CWD: header.CWD, Model: header.Model, Fresh: header.Fresh}, nil
	}
	if err := scanner.Err(); err != nil {
		return ProjectionMetadata{}, err
	}
	return ProjectionMetadata{}, errors.New("invalid Claude projection metadata")
}

func FindProjections(sessionsDir string) (map[string]string, error) {
	store, err := projections.NewStore(sessionsDir, "claude")
	if err != nil {
		return nil, err
	}
	return store.FindValidated(func(path string, _ projections.Metadata) error {
		_, err := ReadProjectionMetadata(path)
		return err
	})
}

func RemoveProjection(sessionsDir, path, nativeID string) error {
	metadata, err := ReadProjectionMetadata(path)
	if err != nil {
		return err
	}
	if metadata.NativeID != nativeID {
		return errors.New("Claude projection native id mismatch")
	}
	store, err := projections.NewStore(sessionsDir, "claude")
	if err != nil {
		return err
	}
	return store.Remove(path, nativeID)
}

func projectTranscript(transcript Transcript) []map[string]any {
	header := map[string]any{
		"type":          "session",
		"version":       3,
		"id":            "claude-" + transcript.NativeID,
		"timestamp":     transcript.CreatedAt.UTC().Format("2006-01-02T15:04:05.999999999Z07:00"),
		"updatedAt":     transcript.UpdatedAt.UTC().Format("2006-01-02T15:04:05.999999999Z07:00"),
		"cwd":           transcript.CWD,
		"runtime":       "claude",
		"nativeId":      transcript.NativeID,
		"provider":      Provider,
		"modelProvider": Provider,
		"name":          transcript.Title,
		"preview":       transcript.Preview,
	}
	if transcript.Model != "" {
		header["model"] = transcript.Model
	}
	if transcript.ClaudeVersion != "" {
		header["claudeVersion"] = transcript.ClaudeVersion
	}
	if transcript.Mode != "" {
		header["claudeMode"] = transcript.Mode
	}
	if transcript.PermissionMode != "" {
		header["claudePermissionMode"] = transcript.PermissionMode
	}
	entries := []map[string]any{header}

	toolNames := map[string]string{}
	for _, rec := range transcript.Records {
		if rec.Message == nil {
			continue
		}
		for _, block := range rawBlocks(rec.Message.Content) {
			if rawString(block["type"]) == "tool_use" {
				toolNames[rawString(block["id"])] = rawString(block["name"])
			}
		}
	}

	type projectedRecord struct {
		record  record
		entries []map[string]any
	}
	projected := make([]projectedRecord, 0, len(transcript.Records))
	seenUsage := map[string]struct{}{}
	for _, rec := range transcript.Records {
		includeUsage := true
		if rec.Message != nil && rec.Message.ID != "" {
			if _, duplicate := seenUsage[rec.Message.ID]; duplicate {
				includeUsage = false
			} else {
				seenUsage[rec.Message.ID] = struct{}{}
			}
		}
		items := projectRecord(transcript.NativeID, rec, toolNames, includeUsage)
		projected = append(projected, projectedRecord{record: rec, entries: items})
	}
	lastProjected := map[string]string{}
	parents := map[string]string{}
	for _, item := range projected {
		if item.record.UUID != "" {
			parents[item.record.UUID] = item.record.ParentUUID
		}
		if len(item.entries) > 0 && item.record.UUID != "" {
			lastProjected[item.record.UUID], _ = item.entries[len(item.entries)-1]["id"].(string)
		}
	}
	var resolveParent func(string, map[string]bool) any
	resolveParent = func(nativeUUID string, seen map[string]bool) any {
		if nativeUUID == "" || seen[nativeUUID] {
			return nil
		}
		seen[nativeUUID] = true
		if id := lastProjected[nativeUUID]; id != "" {
			return id
		}
		return resolveParent(parents[nativeUUID], seen)
	}
	for _, item := range projected {
		parent := resolveParent(item.record.ParentUUID, map[string]bool{})
		for _, entry := range item.entries {
			entry["parentId"] = parent
			parent = entry["id"]
			entries = append(entries, entry)
		}
	}
	return entries
}

func projectRecord(nativeID string, rec record, toolNames map[string]string, includeUsage bool) []map[string]any {
	base := map[string]any{
		"timestamp":        recordTimestamp(rec),
		"claudeRecordType": rec.Type,
		"claudeRaw":        json.RawMessage(rec.Raw),
	}
	if rec.UUID != "" {
		base["claudeUuid"] = rec.UUID
	}
	newEntry := func(index int) map[string]any {
		entry := cloneMap(base)
		entry["id"] = "claude-" + stableHash(nativeID, rec.Identity, strconv.Itoa(index))
		return entry
	}
	fallback := func(reason string) []map[string]any {
		entry := newEntry(0)
		entry["type"] = "custom_message"
		entry["display"] = true
		entry["customType"] = "claude:" + reason
		entry["content"] = "```json\n" + prettyJSON(rec.Raw) + "\n```"
		return []map[string]any{entry}
	}

	switch rec.Type {
	case "user":
		if rec.Message == nil || rec.Message.Role != "user" || len(rec.Message.Content) == 0 {
			return fallback("malformed-user")
		}
		return projectUserMessage(rec, newEntry, toolNames)
	case "assistant":
		if rec.Message == nil || rec.Message.Role != "assistant" || len(rec.Message.Content) == 0 {
			return fallback("malformed-assistant")
		}
		entry := newEntry(0)
		entry["type"] = "message"
		message := map[string]any{
			"role":     "assistant",
			"provider": Provider,
			"content":  assistantContent(rec.Message.Content),
		}
		if rec.Message.Model != "" {
			message["model"] = rec.Message.Model
		}
		if includeUsage {
			if usage := usageMap(rec.Message.Usage); len(usage) > 0 {
				message["usage"] = usage
			}
		}
		if rec.Message.ID != "" {
			entry["claudeMessageId"] = rec.Message.ID
		}
		entry["message"] = message
		return []map[string]any{entry}
	case "attachment":
		return fallback(rec.Type)
	case "system":
		var raw map[string]json.RawMessage
		if json.Unmarshal(rec.Raw, &raw) == nil && len(raw["content"]) > 0 && string(raw["content"]) != "null" && string(raw["content"]) != `""` {
			return fallback(rec.Type)
		}
		return nil
	case "queue-operation", "last-prompt", "mode", "permission-mode", "file-history-snapshot", "ai-title", "custom-title", "agent-name", "pr-link":
		return nil
	default:
		return fallback(rec.Type)
	}
}

func projectUserMessage(rec record, newEntry func(int) map[string]any, toolNames map[string]string) []map[string]any {
	var plain string
	if json.Unmarshal(rec.Message.Content, &plain) == nil {
		entry := newEntry(0)
		entry["type"] = "message"
		entry["message"] = map[string]any{"role": "user", "content": plain, "provider": Provider}
		return []map[string]any{entry}
	}
	blocks := rawBlocks(rec.Message.Content)
	var userContent []any
	var toolResults []map[string]any
	for _, block := range blocks {
		switch rawString(block["type"]) {
		case "tool_result":
			toolUseID := rawString(block["tool_use_id"])
			toolResults = append(toolResults, map[string]any{
				"role":       "toolResult",
				"toolCallId": toolUseID,
				"toolName":   toolNames[toolUseID],
				"content":    resultContent(block["content"]),
				"isError":    rawBool(block["is_error"]),
			})
		default:
			userContent = append(userContent, normalizeUserBlock(block))
		}
	}
	out := make([]map[string]any, 0, 1+len(toolResults))
	if len(userContent) > 0 {
		entry := newEntry(len(out))
		entry["type"] = "message"
		entry["message"] = map[string]any{"role": "user", "content": userContent, "provider": Provider}
		out = append(out, entry)
	}
	for _, message := range toolResults {
		entry := newEntry(len(out))
		entry["type"] = "message"
		entry["message"] = message
		out = append(out, entry)
	}
	if len(out) == 0 {
		entry := newEntry(0)
		entry["type"] = "message"
		entry["message"] = map[string]any{"role": "user", "content": "", "provider": Provider}
		out = append(out, entry)
	}
	return out
}

func assistantContent(content json.RawMessage) []any {
	var plain string
	if json.Unmarshal(content, &plain) == nil {
		return []any{map[string]any{"type": "text", "text": plain}}
	}
	blocks := rawBlocks(content)
	out := make([]any, 0, len(blocks))
	for _, block := range blocks {
		switch rawString(block["type"]) {
		case "text":
			out = append(out, map[string]any{"type": "text", "text": rawString(block["text"])})
		case "thinking":
			out = append(out, map[string]any{"type": "thinking", "thinking": rawString(block["thinking"])})
		case "tool_use":
			out = append(out, map[string]any{
				"type":      "toolCall",
				"id":        rawString(block["id"]),
				"name":      rawString(block["name"]),
				"arguments": rawAny(block["input"]),
			})
		default:
			out = append(out, map[string]any{"type": "text", "text": "[Unknown Claude content block] " + compactJSON(block)})
		}
	}
	return out
}

func normalizeUserBlock(block map[string]json.RawMessage) any {
	switch rawString(block["type"]) {
	case "text":
		return map[string]any{"type": "text", "text": rawString(block["text"])}
	case "image":
		var source map[string]json.RawMessage
		_ = json.Unmarshal(block["source"], &source)
		return map[string]any{"type": "image", "data": rawString(source["data"]), "mimeType": rawString(source["media_type"])}
	default:
		return map[string]any{"type": "text", "text": "[Unknown Claude user content] " + compactJSON(block)}
	}
}

func resultContent(raw json.RawMessage) []any {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return []any{map[string]any{"type": "text", "text": text}}
	}
	blocks := rawBlocks(raw)
	out := make([]any, 0, len(blocks))
	for _, block := range blocks {
		out = append(out, normalizeUserBlock(block))
	}
	return out
}

func usageMap(raw json.RawMessage) map[string]any {
	var native map[string]any
	if json.Unmarshal(raw, &native) != nil {
		return nil
	}
	total := 0.0
	for _, key := range []string{"input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"} {
		if value, ok := native[key].(float64); ok {
			total += value
		}
	}
	if total > 0 {
		native["totalTokens"] = total
	}
	return native
}

func recordTimestamp(rec record) string {
	if _, err := time.Parse(time.RFC3339Nano, rec.Timestamp); err == nil {
		return rec.Timestamp
	}
	return "1970-01-01T00:00:00Z"
}

func rawBlocks(raw json.RawMessage) []map[string]json.RawMessage {
	var blocks []map[string]json.RawMessage
	_ = json.Unmarshal(raw, &blocks)
	return blocks
}

func rawString(raw json.RawMessage) string {
	var value string
	_ = json.Unmarshal(raw, &value)
	return value
}

func rawBool(raw json.RawMessage) bool {
	var value bool
	_ = json.Unmarshal(raw, &value)
	return value
}

func rawAny(raw json.RawMessage) any {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func cloneMap(source map[string]any) map[string]any {
	out := make(map[string]any, len(source)+3)
	for key, value := range source {
		out[key] = value
	}
	return out
}

func stableDigest(value []byte) []byte {
	sum := sha256.Sum256(value)
	return sum[:]
}

func stableHash(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		hash.Write([]byte{0})
		hash.Write([]byte(part))
	}
	return hex.EncodeToString(hash.Sum(nil))[:24]
}

func prettyJSON(raw json.RawMessage) string {
	var out bytes.Buffer
	if err := json.Indent(&out, raw, "", "  "); err != nil {
		return string(raw)
	}
	return out.String()
}

func compactJSON(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}
