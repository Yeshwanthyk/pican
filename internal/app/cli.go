package app

import (
	"flag"
	"fmt"
	"io"
	"net"
	"os"
)

// ParseCLI adapts process arguments to Config without mutating the global flag
// set. The caller owns version output, signal handling, and process exit.
func ParseCLI(args []string, version string, stderr io.Writer) (Config, bool, error) {
	config := DefaultConfig(version)
	applyHostedEnvironment(&config)
	flags := flag.NewFlagSet("pican", flag.ContinueOnError)
	flags.SetOutput(stderr)

	port := flags.String("p", defaultPort, "port to listen on")
	host := flags.String("host", "", "host/IP to bind; defaults to 127.0.0.1")
	flags.BoolVar(&config.OpenBrowser, "o", false, "auto-open browser")
	flags.BoolVar(&config.Insecure, "insecure", false, "allow non-loopback bind without "+tokenEnvVar+" (DANGEROUS)")
	showVersion := flags.Bool("version", false, "print version and exit")
	mode := flags.String("mode", string(config.Mode), "process mode: standalone or hosted")
	authMode := flags.String("auth-mode", string(config.AuthMode), "authentication mode: token or proxy")
	flags.StringVar(&config.BasePath, "base-path", config.BasePath, "HTTP mount path")
	flags.StringVar(&config.WorkspaceRoot, "workspace-root", config.WorkspaceRoot, "hosted workspace root")
	flags.StringVar(&config.StateRoot, "state-root", config.StateRoot, "pican mutable state root")
	flags.StringVar(&config.ProxyAuthHeader, "proxy-auth-header", config.ProxyAuthHeader, "trusted proxy auth header")
	flags.StringVar(&config.Runtime, "runtime", "auto", "agent runtimes: auto, pi, codex, claude, opencode, both, or a comma-separated list")
	flags.StringVar(&config.CodexCommand, "codex-command", "", "path to the Codex executable")
	flags.StringVar(&config.ClaudeCommand, "claude-command", "", "path to the Claude executable")
	flags.StringVar(&config.ClaudeHome, "claude-home", "", "Claude config home containing projects/")
	flags.StringVar(&config.OpenCodeCommand, "opencode-command", "", "path to the OpenCode executable")
	if err := flags.Parse(args); err != nil {
		return Config{}, false, err
	}
	if flags.NArg() != 0 {
		err := fmt.Errorf("unexpected arguments: %v", flags.Args())
		fmt.Fprintln(stderr, err)
		return Config{}, false, err
	}
	config.Mode = Mode(*mode)
	config.AuthMode = AuthMode(*authMode)
	if config.AuthMode == AuthModeProxy {
		config.AuthToken = os.Getenv(proxyTokenEnvVar)
	}
	if config.Mode == ModeHosted {
		config.ChildEnv = hostedCodexChildEnv(os.Environ())
	}

	bindHost := chooseBindHost(*host)
	config.ListenAddress = net.JoinHostPort(bindHost, *port)
	config.HostExplicit = *host != ""
	return config, *showVersion, nil
}

func applyHostedEnvironment(config *Config) {
	if value := os.Getenv(modeEnvVar); value != "" {
		config.Mode = Mode(value)
	}
	if value := os.Getenv(basePathEnvVar); value != "" {
		config.BasePath = value
	}
	if value := os.Getenv(workspaceEnvVar); value != "" {
		config.WorkspaceRoot = value
	}
	if value := os.Getenv(stateRootEnvVar); value != "" {
		config.StateRoot = value
	}
	if value := os.Getenv(authModeEnvVar); value != "" {
		config.AuthMode = AuthMode(value)
	} else if config.Mode == ModeHosted {
		config.AuthMode = AuthModeProxy
	}
	if value := os.Getenv(proxyHeaderEnvVar); value != "" {
		config.ProxyAuthHeader = value
	} else if config.Mode == ModeHosted {
		config.ProxyAuthHeader = "X-Pican-Proxy-Token"
	}
	if config.AuthMode == AuthModeProxy {
		config.AuthToken = os.Getenv(proxyTokenEnvVar)
	}
}
