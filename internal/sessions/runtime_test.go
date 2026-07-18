package sessions

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseRuntimeMetadataDefaultsPiAndReadsCodexHeader(t *testing.T) {
	root := t.TempDir()
	piPath := filepath.Join(root, "pi.jsonl")
	if err := os.WriteFile(piPath, []byte(`{"type":"session","id":"pi-id","cwd":"`+root+`"}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	pi, err := ParseFile(piPath, "project", "pi.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if pi.Runtime != "pi" || pi.NativeID != "" {
		t.Fatalf("Pi metadata = runtime %q native %q", pi.Runtime, pi.NativeID)
	}

	codexPath := filepath.Join(root, "codex-thread.jsonl")
	data := `{"type":"session","id":"codex-thread","cwd":"` + root + `","runtime":"codex","nativeId":"thread","model":"gpt","modelProvider":"openai-codex"}` + "\n"
	if err := os.WriteFile(codexPath, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	summary, err := ParseSummary(codexPath, "project", "codex-thread.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Runtime != "codex" || summary.NativeID != "thread" || summary.Model != "gpt" || summary.ModelProvider != "openai-codex" {
		t.Fatalf("Codex metadata = %+v", summary)
	}
}
