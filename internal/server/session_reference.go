package server

import (
	"path/filepath"
	"strings"
)

func sessionUUIDFromReference(session string) string {
	if session == "" {
		return ""
	}
	name := filepath.Base(session)
	if strings.HasSuffix(name, ".jsonl") {
		name = strings.TrimSuffix(name, ".jsonl")
		if separator := strings.LastIndex(name, "_"); separator >= 0 {
			return name[separator+1:]
		}
	}
	return name
}
