package opencode

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFetchModelsUsesOpenCodeProviderAndCompositeNativeID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/provider" {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{
			"connected":["anthropic"],
			"all":[
				{"id":"anthropic","name":"Anthropic","models":{"claude-sonnet":{"id":"claude-sonnet","name":"Claude Sonnet"}}},
				{"id":"offline","name":"Offline","models":{"same":{"id":"same","name":"Unavailable"}}}
			]
		}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "pican", "secret", nil, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	models, err := FetchModels(context.Background(), client, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 {
		t.Fatalf("models = %#v", models)
	}
	model := models[0]
	if model.Provider != "opencode" || model.ID != "anthropic/claude-sonnet" || model.Model != model.ID {
		t.Fatalf("model = %#v", model)
	}
	if model.Reasoning || model.ThinkingLevelMap["high"] != nil {
		t.Fatalf("unsupported reasoning controls exposed: %#v", model)
	}
}

func TestParseModelIDPreservesSlashInNativeModel(t *testing.T) {
	provider, model, err := ParseModelID("openrouter/vendor/model")
	if err != nil {
		t.Fatal(err)
	}
	if provider != "openrouter" || model != "vendor/model" {
		t.Fatalf("parsed = %q %q", provider, model)
	}
}
