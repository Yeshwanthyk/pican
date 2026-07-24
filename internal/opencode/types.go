package opencode

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	RuntimeID = "opencode"
	Provider  = "opencode"
)

// ModelID namespaces a native OpenCode provider/model pair within pican's
// single OpenCode provider row.
func ModelID(nativeProviderID, nativeModelID string) string {
	return nativeProviderID + "/" + nativeModelID
}

func ParseModelID(modelID string) (nativeProviderID, nativeModelID string, err error) {
	nativeProviderID, nativeModelID, ok := strings.Cut(modelID, "/")
	if !ok || nativeProviderID == "" || nativeModelID == "" {
		return "", "", errors.New("OpenCode model must use the <native-provider>/<native-model> form")
	}
	return nativeProviderID, nativeModelID, nil
}

// Health is the authenticated readiness and version response exposed by
// OpenCode's global endpoint.
type Health struct {
	Healthy bool   `json:"healthy"`
	Version string `json:"version"`
}

type SessionTime struct {
	Created    int64 `json:"created"`
	Updated    int64 `json:"updated"`
	Archived   int64 `json:"archived,omitempty"`
	Compacting int64 `json:"compacting,omitempty"`
}

type ModelRef struct {
	ID         string `json:"id,omitempty"`
	ProviderID string `json:"providerID,omitempty"`
	ModelID    string `json:"modelID,omitempty"`
	Variant    string `json:"variant,omitempty"`
}

// Session intentionally models only stable fields used by pican. Raw retains
// the complete native object so new OpenCode fields survive adapter boundaries.
type Session struct {
	ID        string          `json:"id"`
	Slug      string          `json:"slug,omitempty"`
	ProjectID string          `json:"projectID,omitempty"`
	ParentID  string          `json:"parentID,omitempty"`
	Directory string          `json:"directory"`
	Title     string          `json:"title"`
	Version   string          `json:"version,omitempty"`
	Model     *ModelRef       `json:"model,omitempty"`
	Time      SessionTime     `json:"time"`
	Raw       json.RawMessage `json:"-"`
}

func (s *Session) UnmarshalJSON(data []byte) error {
	type wire Session
	var decoded wire
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*s = Session(decoded)
	s.Raw = append(s.Raw[:0], data...)
	return nil
}

type MessageInfo struct {
	ID         string          `json:"id"`
	SessionID  string          `json:"sessionID"`
	Role       string          `json:"role"`
	ParentID   string          `json:"parentID,omitempty"`
	ProviderID string          `json:"providerID,omitempty"`
	ModelID    string          `json:"modelID,omitempty"`
	Model      *ModelRef       `json:"model,omitempty"`
	Error      json.RawMessage `json:"error,omitempty"`
	Time       struct {
		Created   int64 `json:"created,omitempty"`
		Completed int64 `json:"completed,omitempty"`
	} `json:"time,omitempty"`
	Raw json.RawMessage `json:"-"`
}

func (m *MessageInfo) UnmarshalJSON(data []byte) error {
	type wire MessageInfo
	var decoded wire
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*m = MessageInfo(decoded)
	m.Raw = append(m.Raw[:0], data...)
	return nil
}

type Part struct {
	ID        string          `json:"id,omitempty"`
	SessionID string          `json:"sessionID,omitempty"`
	MessageID string          `json:"messageID,omitempty"`
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	Reasoning string          `json:"reasoning,omitempty"`
	Tool      string          `json:"tool,omitempty"`
	CallID    string          `json:"callID,omitempty"`
	Mime      string          `json:"mime,omitempty"`
	Filename  string          `json:"filename,omitempty"`
	URL       string          `json:"url,omitempty"`
	State     json.RawMessage `json:"state,omitempty"`
	Raw       json.RawMessage `json:"-"`
}

func (p *Part) UnmarshalJSON(data []byte) error {
	type wire Part
	var decoded wire
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*p = Part(decoded)
	p.Raw = append(p.Raw[:0], data...)
	return nil
}

type Message struct {
	Info  MessageInfo `json:"info"`
	Parts []Part      `json:"parts"`
}

type ProviderModel struct {
	ID          string                     `json:"id,omitempty"`
	Name        string                     `json:"name,omitempty"`
	Family      string                     `json:"family,omitempty"`
	ReleaseDate string                     `json:"release_date,omitempty"`
	Attachment  bool                       `json:"attachment,omitempty"`
	Reasoning   bool                       `json:"reasoning,omitempty"`
	Modalities  map[string][]string        `json:"modalities,omitempty"`
	Variants    map[string]json.RawMessage `json:"variants,omitempty"`
	Raw         json.RawMessage            `json:"-"`
}

func (m *ProviderModel) UnmarshalJSON(data []byte) error {
	type wire ProviderModel
	var decoded wire
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*m = ProviderModel(decoded)
	m.Raw = append(m.Raw[:0], data...)
	return nil
}

type NativeProvider struct {
	ID      string                   `json:"id"`
	Name    string                   `json:"name"`
	Source  string                   `json:"source,omitempty"`
	Models  map[string]ProviderModel `json:"models"`
	Options json.RawMessage          `json:"options,omitempty"`
}

type ProviderResponse struct {
	All       []NativeProvider  `json:"all"`
	Default   map[string]string `json:"default"`
	Connected []string          `json:"connected"`
}

type SessionStatus struct {
	Type    string          `json:"type"`
	Attempt int             `json:"attempt,omitempty"`
	Message string          `json:"message,omitempty"`
	Raw     json.RawMessage `json:"-"`
}

func (s *SessionStatus) UnmarshalJSON(data []byte) error {
	type wire SessionStatus
	var decoded wire
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*s = SessionStatus(decoded)
	s.Raw = append(s.Raw[:0], data...)
	return nil
}

type EventPayload struct {
	ID         string          `json:"id,omitempty"`
	Type       string          `json:"type"`
	Properties json.RawMessage `json:"properties"`
}

// Event is the /global/event envelope. SessionID extracts the native routing
// key from event properties and intentionally returns empty for global events.
type Event struct {
	Directory string          `json:"directory,omitempty"`
	Project   string          `json:"project,omitempty"`
	Workspace string          `json:"workspace,omitempty"`
	Payload   EventPayload    `json:"payload"`
	Raw       json.RawMessage `json:"-"`
}

func (e *Event) UnmarshalJSON(data []byte) error {
	type wire Event
	var decoded wire
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*e = Event(decoded)
	e.Raw = append(e.Raw[:0], data...)
	return nil
}

func (e Event) SessionID() string {
	var identity struct {
		SessionID string `json:"sessionID"`
		Info      struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionID"`
		} `json:"info"`
		Part struct {
			SessionID string `json:"sessionID"`
		} `json:"part"`
	}
	if json.Unmarshal(e.Payload.Properties, &identity) != nil {
		return ""
	}
	if identity.SessionID != "" {
		return identity.SessionID
	}
	if identity.Info.SessionID != "" {
		return identity.Info.SessionID
	}
	if identity.Part.SessionID != "" {
		return identity.Part.SessionID
	}
	switch e.Payload.Type {
	case "session.created", "session.updated", "session.deleted":
		return identity.Info.ID
	default:
		return ""
	}
}

type CreateSessionRequest struct {
	ParentID string          `json:"parentID,omitempty"`
	Title    string          `json:"title,omitempty"`
	Agent    string          `json:"agent,omitempty"`
	Model    *CreateModelRef `json:"model,omitempty"`
	Metadata map[string]any  `json:"metadata,omitempty"`
}

type CreateModelRef struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerID"`
	Variant    string `json:"variant,omitempty"`
}

type UpdateSessionRequest struct {
	Title    string          `json:"title,omitempty"`
	Archived *int64          `json:"archived,omitempty"`
	Model    *CreateModelRef `json:"model,omitempty"`
}

type ForkSessionRequest struct {
	MessageID string `json:"messageID,omitempty"`
}

type PromptRequest struct {
	MessageID string          `json:"messageID,omitempty"`
	Model     *PromptModelRef `json:"model,omitempty"`
	Agent     string          `json:"agent,omitempty"`
	Variant   string          `json:"variant,omitempty"`
	Parts     []PromptPart    `json:"parts"`
}

type PromptModelRef struct {
	ProviderID string `json:"providerID"`
	ModelID    string `json:"modelID"`
}

type PromptPart struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Mime     string `json:"mime,omitempty"`
	Filename string `json:"filename,omitempty"`
	URL      string `json:"url,omitempty"`
}

type NativeCommand struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source,omitempty"`
}

// Availability is level-triggered supervisor state.
type Availability struct {
	Available bool
	Version   string
	Err       error
	ChangedAt time.Time
}
