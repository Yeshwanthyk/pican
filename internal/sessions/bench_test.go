package sessions

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// generateLargeSessionContent creates a realistic JSONL session file with n messages.
func generateLargeSessionContent(n int, cwd string) string {
	var sb strings.Builder
	sb.WriteString(`{"type":"session","version":3,"id":"bench-session-id","name":"Benchmark Session","timestamp":"2026-01-01T00:00:00Z","cwd":"` + cwd + `"}` + "\n")
	for i := 0; i < n; i++ {
		ts := fmt.Sprintf("2026-01-01T%02d:%02d:%02dZ", i/3600, (i/60)%60, i%60)
		if i%2 == 0 {
			sb.WriteString(`{"type":"message","id":"` + fmt.Sprintf("msg%06d", i) + `","timestamp":"` + ts + `","message":{"role":"user","content":"This is a user message number ` + fmt.Sprintf("%d", i) + ` with some content to make it realistic in size. It might include code or questions.","usage":{"totalTokens":50,"cost":{"total":0.001}}}}` + "\n")
		} else {
			sb.WriteString(`{"type":"message","id":"` + fmt.Sprintf("msg%06d", i) + `","timestamp":"` + ts + `","message":{"role":"assistant","content":[{"type":"text","text":"This is an assistant response number ` + fmt.Sprintf("%d", i) + `. It contains a detailed explanation with multiple sentences and technical content."}],"usage":{"totalTokens":200,"cost":{"total":0.004}}}}` + "\n")
		}
	}
	return sb.String()
}

func BenchmarkParseSummarySmall(b *testing.B) {
	tmp := b.TempDir()
	cwd := filepath.Join(tmp, "project")
	os.MkdirAll(cwd, 0755)
	path := filepath.Join(tmp, "session.jsonl")
	os.WriteFile(path, []byte(generateLargeSessionContent(10, cwd)), 0644)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := ParseSummary(path, "--bench--project--", "session.jsonl")
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkParseSummaryLarge(b *testing.B) {
	tmp := b.TempDir()
	cwd := filepath.Join(tmp, "project")
	os.MkdirAll(cwd, 0755)
	path := filepath.Join(tmp, "session.jsonl")
	os.WriteFile(path, []byte(generateLargeSessionContent(200, cwd)), 0644)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := ParseSummary(path, "--bench--project--", "session.jsonl")
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkParseFileSmall(b *testing.B) {
	tmp := b.TempDir()
	cwd := filepath.Join(tmp, "project")
	os.MkdirAll(cwd, 0755)
	path := filepath.Join(tmp, "session.jsonl")
	os.WriteFile(path, []byte(generateLargeSessionContent(10, cwd)), 0644)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := ParseFile(path, "--bench--project--", "session.jsonl")
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkParseFileLarge(b *testing.B) {
	tmp := b.TempDir()
	cwd := filepath.Join(tmp, "project")
	os.MkdirAll(cwd, 0755)
	path := filepath.Join(tmp, "session.jsonl")
	os.WriteFile(path, []byte(generateLargeSessionContent(200, cwd)), 0644)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := ParseFile(path, "--bench--project--", "session.jsonl")
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLoadAll10(b *testing.B) {
	tmp := b.TempDir()
	cwd := filepath.Join(tmp, "cwd")
	os.MkdirAll(cwd, 0755)
	for i := 0; i < 10; i++ {
		dir := filepath.Join(tmp, fmt.Sprintf("--project-%02d--", i))
		os.MkdirAll(dir, 0755)
		path := filepath.Join(dir, fmt.Sprintf("session-%02d.jsonl", i))
		os.WriteFile(path, []byte(generateLargeSessionContent(50, cwd)), 0644)
	}
	c := NewCache()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c2 := NewCache()
		_, err := c2.LoadAll(tmp)
		if err != nil {
			b.Fatal(err)
		}
	}
	_ = c
}

func BenchmarkLoadAllCached10(b *testing.B) {
	tmp := b.TempDir()
	cwd := filepath.Join(tmp, "cwd")
	os.MkdirAll(cwd, 0755)
	for i := 0; i < 10; i++ {
		dir := filepath.Join(tmp, fmt.Sprintf("--project-%02d--", i))
		os.MkdirAll(dir, 0755)
		path := filepath.Join(dir, fmt.Sprintf("session-%02d.jsonl", i))
		os.WriteFile(path, []byte(generateLargeSessionContent(50, cwd)), 0644)
	}
	c := NewCache()
	c.LoadAll(tmp) // warm the cache
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := c.LoadAll(tmp)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLoadAll100(b *testing.B) {
	tmp := b.TempDir()
	cwd := filepath.Join(tmp, "cwd")
	os.MkdirAll(cwd, 0755)
	for i := 0; i < 100; i++ {
		dir := filepath.Join(tmp, fmt.Sprintf("--project-%02d--", i%10))
		os.MkdirAll(dir, 0755)
		path := filepath.Join(dir, fmt.Sprintf("session-%03d.jsonl", i))
		os.WriteFile(path, []byte(generateLargeSessionContent(50, cwd)), 0644)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c := NewCache()
		_, err := c.LoadAll(tmp)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLoadAllCached100(b *testing.B) {
	tmp := b.TempDir()
	cwd := filepath.Join(tmp, "cwd")
	os.MkdirAll(cwd, 0755)
	for i := 0; i < 100; i++ {
		dir := filepath.Join(tmp, fmt.Sprintf("--project-%02d--", i%10))
		os.MkdirAll(dir, 0755)
		path := filepath.Join(dir, fmt.Sprintf("session-%03d.jsonl", i))
		os.WriteFile(path, []byte(generateLargeSessionContent(50, cwd)), 0644)
	}
	c := NewCache()
	c.LoadAll(tmp) // warm
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := c.LoadAll(tmp)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkResolveByID(b *testing.B) {
	tmp := b.TempDir()
	cwd := filepath.Join(tmp, "cwd")
	os.MkdirAll(cwd, 0755)
	// 50 sessions across 5 projects
	for i := 0; i < 50; i++ {
		dir := filepath.Join(tmp, fmt.Sprintf("--project-%02d--", i%5))
		os.MkdirAll(dir, 0755)
		path := filepath.Join(dir, fmt.Sprintf("session-%03d.jsonl", i))
		os.WriteFile(path, []byte(generateLargeSessionContent(50, cwd)), 0644)
	}
	targetDir := filepath.Join(tmp, "--project-04--")
	os.MkdirAll(targetDir, 0755)
	targetPath := filepath.Join(targetDir, "target-session.jsonl")
	os.WriteFile(targetPath, []byte(generateLargeSessionContent(100, cwd)), 0644)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := ResolveByID(tmp, "target-session.jsonl")
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkResolveByIDCached(b *testing.B) {
	tmp := b.TempDir()
	cwd := filepath.Join(tmp, "cwd")
	os.MkdirAll(cwd, 0755)
	for i := 0; i < 50; i++ {
		dir := filepath.Join(tmp, fmt.Sprintf("--project-%02d--", i%5))
		os.MkdirAll(dir, 0755)
		path := filepath.Join(dir, fmt.Sprintf("session-%03d.jsonl", i))
		os.WriteFile(path, []byte(generateLargeSessionContent(50, cwd)), 0644)
	}
	targetDir := filepath.Join(tmp, "--project-04--")
	os.MkdirAll(targetDir, 0755)
	targetPath := filepath.Join(targetDir, "target-session.jsonl")
	os.WriteFile(targetPath, []byte(generateLargeSessionContent(100, cwd)), 0644)

	c := NewCache()
	c.LoadAll(tmp) // warm path index

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := c.Resolve(tmp, "target-session.jsonl")
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkSortSummaries100(b *testing.B) {
	summaries := make([]SessionSummary, 100)
	for i := range summaries {
		summaries[i] = SessionSummary{
			LastActivity: fmt.Sprintf("2026-01-%02dT%02d:00:00Z", (i%28)+1, i%24),
		}
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		cp := make([]SessionSummary, len(summaries))
		copy(cp, summaries)
		SortSummariesByActivity(cp)
	}
}
