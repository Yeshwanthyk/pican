package sessions

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadTitleInputsTreatsMarkedHeaderNameAsAutoTitle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	content := `{"type":"session","name":"New Codex session","autoTitle":true}` + "\n" +
		`{"type":"message","message":{"role":"user","content":"fix codex session naming"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	inputs, err := ReadTitleInputs(path)
	if err != nil {
		t.Fatal(err)
	}
	if !inputs.HasExplicitName || !inputs.AutoTitled {
		t.Fatalf("title inputs = %+v, want marked auto-title", inputs)
	}
}
