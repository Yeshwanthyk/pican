package opencode

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
	"strings"
	"time"

	"pican/internal/projections"
	"pican/internal/sessions"
)

const maxProjectionLineBytes = 32 << 20

type Projection struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	NativeID string `json:"nativeId"`
}

type ProjectionMetadata struct {
	NativeID string
	CWD      string
	Model    string
}

func Materialize(sessionsDir string, session Session, messages []Message) (Projection, error) {
	cwd, err := CanonicalDirectory(session.Directory)
	if err != nil {
		return Projection{}, err
	}
	session.Directory = cwd
	store, err := projections.NewStore(sessionsDir, RuntimeID)
	if err != nil {
		return Projection{}, err
	}
	projected, err := store.Replace(session.ID, cwd, func([]string) ([]map[string]any, error) {
		return projectSession(session, messages), nil
	})
	if err != nil {
		return Projection{}, err
	}
	return Projection{ID: projected.ID, Path: projected.Path, NativeID: projected.NativeID}, nil
}

func ReadProjectionMetadata(path string) (ProjectionMetadata, error) {
	if !strings.HasPrefix(filepath.Base(path), RuntimeID+"-") {
		return ProjectionMetadata{}, errors.New("not an OpenCode projection")
	}
	store, err := projections.NewStore(filepath.Dir(filepath.Dir(path)), RuntimeID)
	if err != nil {
		return ProjectionMetadata{}, err
	}
	identity, err := store.ReadMetadata(path)
	if err != nil {
		return ProjectionMetadata{}, err
	}
	expectedPath, err := store.Path(identity.NativeID, identity.CWD)
	if err != nil {
		return ProjectionMetadata{}, err
	}
	actualPath, err := filepath.Abs(path)
	if err != nil || filepath.Clean(actualPath) != expectedPath {
		return ProjectionMetadata{}, errors.New("invalid OpenCode projection path")
	}
	f, err := os.Open(path)
	if err != nil {
		return ProjectionMetadata{}, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), maxProjectionLineBytes)
	var metadata ProjectionMetadata
	for scanner.Scan() {
		var entry struct {
			Type          string `json:"type"`
			Runtime       string `json:"runtime"`
			NativeID      string `json:"nativeId"`
			CWD           string `json:"cwd"`
			Provider      string `json:"provider"`
			ModelProvider string `json:"modelProvider"`
			Model         string `json:"model"`
			ModelID       string `json:"modelId"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			return ProjectionMetadata{}, fmt.Errorf("decode OpenCode projection: %w", err)
		}
		switch entry.Type {
		case "session":
			if entry.Runtime != identity.Runtime || entry.NativeID != identity.NativeID || entry.CWD != identity.CWD || entry.Provider != Provider || entry.ModelProvider != Provider {
				return ProjectionMetadata{}, errors.New("invalid OpenCode projection metadata")
			}
			metadata = ProjectionMetadata{NativeID: entry.NativeID, CWD: entry.CWD, Model: entry.Model}
		case "model_change":
			metadata.Model = entry.ModelID
		}
	}
	if err := scanner.Err(); err != nil {
		return ProjectionMetadata{}, err
	}
	if metadata.NativeID == "" {
		return ProjectionMetadata{}, errors.New("invalid OpenCode projection metadata")
	}
	return metadata, nil
}

func FindProjections(sessionsDir string) (map[string]string, error) {
	store, err := projections.NewStore(sessionsDir, RuntimeID)
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
		return errors.New("OpenCode projection native id mismatch")
	}
	store, err := projections.NewStore(sessionsDir, RuntimeID)
	if err != nil {
		return err
	}
	return store.Remove(path, nativeID)
}

var ErrNoMessageBoundary = errors.New("OpenCode entry has no native message boundary")

func ResolveMessageID(path, entryID string) (string, error) {
	if _, err := ReadProjectionMetadata(path); err != nil {
		return "", err
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), maxProjectionLineBytes)
	for scanner.Scan() {
		var entry struct {
			ID                string `json:"id"`
			OpenCodeMessageID string `json:"opencodeMessageId"`
		}
		if json.Unmarshal(scanner.Bytes(), &entry) == nil && entry.ID == entryID {
			if entry.OpenCodeMessageID == "" {
				return "", ErrNoMessageBoundary
			}
			return entry.OpenCodeMessageID, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", sessions.ErrSessionEntryNotFound
}

func LabelSessionEntry(path, targetID, label string, now func() time.Time) error {
	store, err := projectionStoreForPath(path)
	if err != nil {
		return err
	}
	return store.Label(path, targetID, label, now)
}

func AutoTitleSession(path, name string, now func() time.Time) error {
	store, err := projectionStoreForPath(path)
	if err != nil {
		return err
	}
	return store.AutoTitle(path, name, now)
}

func RenameProjection(path, name string, now func() time.Time) error {
	store, err := projectionStoreForPath(path)
	if err != nil {
		return err
	}
	return store.Rename(path, name, now)
}

func projectSession(native Session, messages []Message) []map[string]any {
	created := nativeTime(native.Time.Created)
	updated := nativeTime(native.Time.Updated)
	model := sessionModel(native, messages)
	header := map[string]any{
		"type": "session", "version": 3, "id": RuntimeID + "-" + native.ID,
		"timestamp": created, "updatedAt": updated, "cwd": native.Directory,
		"runtime": RuntimeID, "nativeId": native.ID, "name": native.Title,
		"preview": firstUserText(messages), "provider": Provider, "modelProvider": Provider,
		"opencodeRaw": rawOrValue(native.Raw, native),
	}
	if model != "" {
		header["model"] = model
	}
	if native.ParentID != "" {
		header["opencodeParentId"] = native.ParentID
	}
	entries := []map[string]any{header}
	var parent any
	for messageIndex, message := range messages {
		projected := projectMessage(native.ID, message, messageIndex, model)
		for _, entry := range projected {
			entry["parentId"] = parent
			parent = entry["id"]
			entries = append(entries, entry)
		}
	}
	return entries
}

func projectMessage(sessionID string, native Message, messageIndex int, fallbackModel string) []map[string]any {
	info := native.Info
	rawMessage := map[string]any{"info": rawOrValue(info.Raw, info), "parts": rawParts(native.Parts)}
	base := func(part Part, index int) map[string]any {
		partID := part.ID
		if partID == "" {
			partID = fmt.Sprintf("%d", index)
		}
		return map[string]any{
			"id":        RuntimeID + "-" + stableHash(sessionID, info.ID, partID, fmt.Sprint(index)),
			"timestamp": nativeTime(info.Time.Created), "opencodeMessageId": info.ID,
			"opencodePartId": part.ID, "opencodeRaw": rawMessage,
			"opencodePartRaw": rawOrValue(part.Raw, part),
		}
	}
	fallback := func(part Part, index int, reason string) map[string]any {
		entry := base(part, index)
		entry["type"] = "custom_message"
		entry["display"] = true
		entry["customType"] = "opencode:" + reason
		entry["content"] = "```json\n" + prettyJSON(part.Raw) + "\n```"
		return entry
	}
	model := fallbackModel
	providerID, modelID := info.ProviderID, info.ModelID
	if info.Model != nil {
		if providerID == "" {
			providerID = info.Model.ProviderID
		}
		if modelID == "" {
			modelID = info.Model.ModelID
			if modelID == "" {
				modelID = info.Model.ID
			}
		}
	}
	if providerID != "" && modelID != "" {
		model = ModelID(providerID, modelID)
	}
	messageValue := func(role string, content any) map[string]any {
		value := map[string]any{"role": role, "content": content, "provider": Provider}
		if model != "" {
			value["model"] = model
		}
		return value
	}

	if info.Role != "user" && info.Role != "assistant" {
		entry := base(Part{ID: info.ID, Type: "message-info", Raw: info.Raw}, messageIndex)
		entry["type"] = "custom_message"
		entry["display"] = true
		entry["customType"] = "opencode:message-role-" + info.Role
		entry["content"] = "```json\n" + prettyValueJSON(rawMessage) + "\n```"
		return []map[string]any{entry}
	}

	if info.Role == "user" {
		var blocks []any
		for _, part := range native.Parts {
			switch part.Type {
			case "text":
				blocks = append(blocks, map[string]any{"type": "text", "text": part.Text})
			case "file":
				blocks = append(blocks, projectFileBlock(part))
			default:
				blocks = append(blocks, map[string]any{"type": "text", "text": "[OpenCode " + part.Type + "] " + compactJSON(rawOrValue(part.Raw, part))})
			}
		}
		entry := base(Part{ID: info.ID, Raw: info.Raw}, messageIndex)
		entry["type"] = "message"
		entry["message"] = messageValue("user", blocks)
		return []map[string]any{entry}
	}

	var out []map[string]any
	for index, part := range native.Parts {
		switch part.Type {
		case "text":
			entry := base(part, index)
			entry["type"] = "message"
			entry["message"] = messageValue("assistant", []any{map[string]any{"type": "text", "text": part.Text}})
			out = append(out, entry)
		case "reasoning":
			text := part.Reasoning
			if text == "" {
				text = part.Text
			}
			entry := base(part, index)
			entry["type"] = "message"
			entry["message"] = messageValue("assistant", []any{map[string]any{"type": "thinking", "thinking": text}})
			out = append(out, entry)
		case "tool":
			out = append(out, projectToolPart(base, part, index, messageValue)...)
		case "file":
			entry := base(part, index)
			entry["type"] = "message"
			entry["message"] = messageValue("assistant", []any{projectFileBlock(part)})
			out = append(out, entry)
		default:
			out = append(out, fallback(part, index, part.Type))
		}
	}
	if len(out) == 0 || len(info.Error) > 0 && string(info.Error) != "null" {
		part := Part{ID: info.ID, Type: "message-info", Raw: info.Raw}
		entry := fallback(part, len(out), "message-info")
		if len(info.Error) > 0 && string(info.Error) != "null" {
			entry["opencodeError"] = json.RawMessage(info.Error)
		}
		out = append(out, entry)
	}
	return out
}

func projectToolPart(base func(Part, int) map[string]any, part Part, index int, messageValue func(string, any) map[string]any) []map[string]any {
	var state map[string]any
	_ = json.Unmarshal(part.State, &state)
	callID := part.CallID
	if callID == "" {
		callID = part.ID
	}
	arguments := state["input"]
	if arguments == nil {
		arguments = map[string]any{}
	}
	call := base(part, index)
	call["id"] = fmt.Sprint(call["id"]) + "-call"
	call["type"] = "message"
	call["message"] = messageValue("assistant", []any{map[string]any{"type": "toolCall", "id": callID, "name": part.Tool, "arguments": arguments}})

	status := fmt.Sprint(state["status"])
	output := state["output"]
	if output == nil {
		output = state["error"]
	}
	result := base(part, index)
	result["id"] = fmt.Sprint(result["id"]) + "-result"
	result["type"] = "message"
	result["message"] = map[string]any{
		"role": "toolResult", "toolCallId": callID, "toolName": part.Tool,
		"content":   []any{map[string]any{"type": "text", "text": compactText(output)}},
		"isRunning": status == "pending" || status == "running",
		"isError":   status == "error" || state["error"] != nil,
	}
	return []map[string]any{call, result}
}

func projectFileBlock(part Part) map[string]any {
	if strings.HasPrefix(part.URL, "data:") && strings.Contains(part.URL, ",") {
		_, data, _ := strings.Cut(part.URL, ",")
		return map[string]any{"type": "image", "data": data, "mimeType": part.Mime}
	}
	label := part.Filename
	if label == "" {
		label = "file"
	}
	return map[string]any{"type": "text", "text": "[OpenCode file: " + label + "] " + part.URL}
}

func sessionModel(native Session, messages []Message) string {
	if native.Model != nil {
		modelID := native.Model.ModelID
		if modelID == "" {
			modelID = native.Model.ID
		}
		if native.Model.ProviderID != "" && modelID != "" {
			return ModelID(native.Model.ProviderID, modelID)
		}
	}
	for index := len(messages) - 1; index >= 0; index-- {
		info := messages[index].Info
		if info.ProviderID != "" && info.ModelID != "" {
			return ModelID(info.ProviderID, info.ModelID)
		}
	}
	return ""
}

func firstUserText(messages []Message) string {
	for _, message := range messages {
		if message.Info.Role != "user" {
			continue
		}
		for _, part := range message.Parts {
			if part.Type == "text" && strings.TrimSpace(part.Text) != "" {
				return strings.TrimSpace(part.Text)
			}
		}
	}
	return ""
}

func nativeTime(milliseconds int64) string {
	if milliseconds <= 0 {
		return time.Unix(0, 0).UTC().Format(time.RFC3339Nano)
	}
	return time.UnixMilli(milliseconds).UTC().Format(time.RFC3339Nano)
}

func rawOrValue(raw json.RawMessage, value any) any {
	if len(raw) > 0 {
		return json.RawMessage(raw)
	}
	return value
}

func rawParts(parts []Part) []any {
	out := make([]any, 0, len(parts))
	for _, part := range parts {
		out = append(out, rawOrValue(part.Raw, part))
	}
	return out
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
	if len(raw) == 0 {
		return "{}"
	}
	var out bytes.Buffer
	if err := json.Indent(&out, raw, "", "  "); err != nil {
		return string(raw)
	}
	return out.String()
}

func prettyValueJSON(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return prettyJSON(raw)
}

func compactJSON(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func compactText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return compactJSON(value)
}
