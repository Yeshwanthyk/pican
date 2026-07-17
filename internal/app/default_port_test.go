package app

import (
	"os"
	"strings"
	"testing"
)

const expectedDefaultPort = "31415"

func TestDefaultPortMatchesPublishedDefaults(t *testing.T) {
	if defaultPort != expectedDefaultPort {
		t.Fatalf("defaultPort = %q, want %q", defaultPort, expectedDefaultPort)
	}

	files := []string{
		"init/com.pi-web.plist",
		"README.md",
		".pi/extensions/pi-web.ts",
	}

	for _, path := range files {
		data, err := os.ReadFile(repoPath(path))
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if !strings.Contains(string(data), expectedDefaultPort) {
			t.Fatalf("%s does not mention default port %s", path, expectedDefaultPort)
		}
	}
}
