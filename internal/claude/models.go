package claude

// Model is the runtime-neutral shape consumed by pican's model endpoint.
// Claude Code exposes model selection aliases but no stable model-list API, so
// this catalog intentionally uses the documented aliases accepted by --model.
type Model struct {
	Provider         string             `json:"provider"`
	ID               string             `json:"id"`
	Model            string             `json:"model"`
	Name             string             `json:"name"`
	DisplayName      string             `json:"displayName"`
	Reasoning        bool               `json:"reasoning"`
	ThinkingLevelMap map[string]*string `json:"thinkingLevelMap"`
}

func Models() []Model {
	levels := func() map[string]*string {
		return map[string]*string{"off": nil, "minimal": nil, "low": nil, "medium": nil, "high": nil, "xhigh": nil}
	}
	return []Model{
		{Provider: Provider, ID: "sonnet", Model: "sonnet", Name: "Claude Sonnet", DisplayName: "Claude Sonnet", Reasoning: true, ThinkingLevelMap: levels()},
		{Provider: Provider, ID: "opus", Model: "opus", Name: "Claude Opus", DisplayName: "Claude Opus", Reasoning: true, ThinkingLevelMap: levels()},
		{Provider: Provider, ID: "haiku", Model: "haiku", Name: "Claude Haiku", DisplayName: "Claude Haiku", Reasoning: false, ThinkingLevelMap: levels()},
	}
}
