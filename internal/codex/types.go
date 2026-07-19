// Package codex adapts Codex app-server threads to pican sessions and workers.
//
// Codex is the transcript authority. Files written by this package are
// rebuildable projections named codex-<thread-id>.jsonl; the package never
// reads or writes Pi's native session files.
package codex

import (
	"encoding/json"
	"fmt"
)

const Provider = "openai-codex"

// Thread is the stable subset of the app-server thread shape used by pican.
type Thread struct {
	ID             string          `json:"id"`
	SessionID      string          `json:"sessionId,omitempty"`
	Name           string          `json:"name,omitempty"`
	Preview        string          `json:"preview,omitempty"`
	CWD            string          `json:"cwd"`
	Status         json.RawMessage `json:"status,omitempty"`
	CreatedAt      int64           `json:"createdAt,omitempty"`
	UpdatedAt      int64           `json:"updatedAt,omitempty"`
	Turns          []Turn          `json:"turns,omitempty"`
	Source         json.RawMessage `json:"source,omitempty"`
	AgentNickname  string          `json:"agentNickname,omitempty"`
	AgentRole      string          `json:"agentRole,omitempty"`
	ParentThreadID string          `json:"parentThreadId,omitempty"`
	ForkedFromID   string          `json:"forkedFromId,omitempty"`
	Model          string          `json:"model,omitempty"`
	ModelProvider  string          `json:"modelProvider,omitempty"`
	Effort         string          `json:"effort,omitempty"`
	ApprovalPolicy json.RawMessage `json:"approvalPolicy,omitempty"`
	Sandbox        json.RawMessage `json:"sandbox,omitempty"`
	TokenUsage     json.RawMessage `json:"tokenUsage,omitempty"`
	TurnDiff       string          `json:"turnDiff,omitempty"`
}

// Turn is a Codex turn with heterogeneous items retained losslessly.
type Turn struct {
	ID          string       `json:"id"`
	Status      string       `json:"status,omitempty"`
	Items       []ThreadItem `json:"items,omitempty"`
	StartedAt   int64        `json:"startedAt,omitempty"`
	CompletedAt int64        `json:"completedAt,omitempty"`
}

// ThreadItem extracts only identity and kind. Raw preserves all current and
// future schema fields so projections remain forward-compatible.
type ThreadItem struct {
	ID   string
	Type string
	Raw  map[string]json.RawMessage
}

func (i *ThreadItem) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if err := json.Unmarshal(raw["id"], &i.ID); err != nil || i.ID == "" {
		return fmt.Errorf("codex item missing id")
	}
	if err := json.Unmarshal(raw["type"], &i.Type); err != nil || i.Type == "" {
		return fmt.Errorf("codex item %q missing type", i.ID)
	}
	i.Raw = raw
	return nil
}

func (i ThreadItem) MarshalJSON() ([]byte, error) {
	raw := cloneRawMap(i.Raw)
	raw["id"], _ = json.Marshal(i.ID)
	raw["type"], _ = json.Marshal(i.Type)
	return json.Marshal(raw)
}

func cloneRawMap(in map[string]json.RawMessage) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(in)+2)
	for k, v := range in {
		out[k] = append(json.RawMessage(nil), v...)
	}
	return out
}

// UserInput is accepted by turn/start and turn/steer.
type UserInput map[string]any

func TextInput(text string) UserInput {
	return UserInput{"type": "text", "text": text, "text_elements": []any{}}
}
func ImageInput(dataURL string) UserInput { return UserInput{"type": "image", "url": dataURL} }

type ReasoningEffort struct {
	ReasoningEffort string `json:"reasoningEffort"`
	Description     string `json:"description,omitempty"`
}

type Model struct {
	ID                        string            `json:"id"`
	Model                     string            `json:"model"`
	DisplayName               string            `json:"displayName"`
	Description               string            `json:"description,omitempty"`
	DefaultReasoningEffort    string            `json:"defaultReasoningEffort,omitempty"`
	SupportedReasoningEfforts []ReasoningEffort `json:"supportedReasoningEfforts,omitempty"`
	Hidden                    bool              `json:"hidden,omitempty"`
	IsDefault                 bool              `json:"isDefault,omitempty"`
}

// PicanModel is the model shape consumed by pican's existing model endpoint.
type PicanModel struct {
	Provider         string             `json:"provider"`
	ID               string             `json:"id"`
	Model            string             `json:"model"`
	Name             string             `json:"name"`
	DisplayName      string             `json:"displayName"`
	Reasoning        bool               `json:"reasoning"`
	ThinkingLevelMap map[string]*string `json:"thinkingLevelMap"`
}

// MapModels converts app-server models without depending on internal/rpc.
func MapModels(models []Model) []PicanModel {
	out := make([]PicanModel, 0, len(models))
	for _, model := range models {
		levels := map[string]*string{"off": nil, "minimal": nil, "low": nil, "medium": nil, "high": nil, "xhigh": nil}
		for _, effort := range model.SupportedReasoningEfforts {
			value := effort.ReasoningEffort
			levels[value] = &value
		}
		modelID := model.Model
		if modelID == "" {
			modelID = model.ID
		}
		name := model.DisplayName
		if name == "" {
			name = modelID
		}
		out = append(out, PicanModel{Provider: Provider, ID: modelID, Model: modelID, Name: name, DisplayName: name, Reasoning: len(model.SupportedReasoningEfforts) > 0, ThinkingLevelMap: levels})
	}
	return out
}
