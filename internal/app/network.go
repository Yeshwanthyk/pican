package app

import "net"

func chooseBindHost(override string) string {
	if override != "" {
		return override
	}
	return "127.0.0.1"
}

// isLoopbackHost reports whether host is a loopback literal we can safely bind
// without auth: empty (defaults to localhost), "localhost", or any 127.0.0.0/8
// or ::1 address. Hostnames other than "localhost" are treated as non-loopback
// since we can't trust DNS at startup.
func isLoopbackHost(host string) bool {
	if host == "" || host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}
