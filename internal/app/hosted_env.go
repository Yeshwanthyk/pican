package app

import "strings"

// hostedCodexChildEnv reduces the explicitly supplied host environment to the
// process basics plus Codex/GitHub sentinel surfaces. The proxy credential and
// unrelated host/provider secrets never cross the child boundary.
func hostedCodexChildEnv(input []string) []string {
	out := make([]string, 0, len(input))
	index := make(map[string]int)
	for _, entry := range input {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || !allowedHostedCodexEnvKey(key) {
			continue
		}
		if existing, duplicate := index[key]; duplicate {
			out[existing] = entry
			continue
		}
		index[key] = len(out)
		out = append(out, entry)
	}
	return out
}

func allowedHostedCodexEnvKey(key string) bool {
	switch key {
	case "PATH", "HOME", "USER", "LOGNAME", "SHELL",
		"TMPDIR", "TMP", "TEMP", "LANG", "TZ", "TERM", "COLORTERM", "NO_COLOR",
		"SSL_CERT_FILE", "SSL_CERT_DIR",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy":
		return true
	}
	for _, prefix := range []string{"LC_", "XDG_", "CODEX_", "OPENAI_", "GH_", "GITHUB_"} {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}
