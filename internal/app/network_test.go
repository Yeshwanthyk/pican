package app

import "testing"

func TestChooseBindHostUsesOverride(t *testing.T) {
	host := chooseBindHost("192.168.1.50")
	if host != "192.168.1.50" {
		t.Fatalf("host = %q, want override", host)
	}
}

func TestChooseBindHostDefaultsLocalhost(t *testing.T) {
	host := chooseBindHost("")
	if host != "127.0.0.1" {
		t.Fatalf("host = %q, want localhost", host)
	}
}

func TestIsLoopbackHost(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"", true},
		{"localhost", true},
		{"127.0.0.1", true},
		{"127.5.5.5", true},
		{"::1", true},
		{"100.64.0.10", false},
		{"192.168.1.10", false},
		{"example.com", false},
	}
	for _, tc := range cases {
		if got := isLoopbackHost(tc.host); got != tc.want {
			t.Errorf("isLoopbackHost(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}
