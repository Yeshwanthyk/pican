package app

import (
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"pican/internal/agentdir"
	"pican/internal/basepath"
)

type Mode string

const (
	ModeStandalone Mode = "standalone"
	ModeHosted     Mode = "hosted"
)

type AuthMode string

const (
	AuthModeToken AuthMode = "token"
	AuthModeProxy AuthMode = "proxy"
)

const (
	modeEnvVar           = "PICAN_MODE"
	basePathEnvVar       = "PICAN_BASE_PATH"
	workspaceEnvVar      = "PICAN_WORKSPACE_ROOT"
	stateRootEnvVar      = "PICAN_STATE_ROOT"
	authModeEnvVar       = "PICAN_AUTH_MODE"
	proxyHeaderEnvVar    = "PICAN_PROXY_HEADER"
	proxyTokenEnvVar     = "PICAN_PROXY_TOKEN"
	hostNavigationEnvVar = "PICAN_HOST_NAVIGATION_URL"
)

// Config is the process-independent startup contract for pican.
type Config struct {
	ListenAddress     string
	BasePath          string
	WorkspaceRoot     string
	StateRoot         string
	Mode              Mode
	AuthMode          AuthMode
	ProxyAuthHeader   string
	AuthToken         string
	HostNavigationURL string
	ChildEnv          []string
	Runtime           string
	Version           string

	OpenBrowser     bool
	Insecure        bool
	HostExplicit    bool
	CodexCommand    string
	ClaudeCommand   string
	ClaudeHome      string
	OpenCodeCommand string
}

func DefaultConfig(version string) Config {
	return Config{
		ListenAddress: net.JoinHostPort("127.0.0.1", defaultPort),
		BasePath:      "/",
		StateRoot:     agentdir.Path(),
		Mode:          ModeStandalone,
		AuthMode:      AuthModeToken,
		AuthToken:     os.Getenv(tokenEnvVar),
		ChildEnv:      append([]string(nil), os.Environ()...),
		Runtime:       "auto",
		Version:       version,
	}
}

func (c Config) withDefaults() Config {
	defaults := DefaultConfig(c.Version)
	if c.ListenAddress == "" {
		c.ListenAddress = defaults.ListenAddress
	}
	if c.BasePath == "" {
		c.BasePath = defaults.BasePath
	}
	if c.StateRoot == "" {
		c.StateRoot = defaults.StateRoot
	}
	if c.Mode == "" {
		c.Mode = defaults.Mode
	}
	if c.AuthMode == "" {
		c.AuthMode = defaults.AuthMode
	}
	if c.Runtime == "" {
		c.Runtime = defaults.Runtime
	}
	if c.ChildEnv == nil {
		c.ChildEnv = defaults.ChildEnv
	}
	return c
}

func (c Config) validate() error {
	if _, _, err := net.SplitHostPort(c.ListenAddress); err != nil {
		return err
	}
	if _, err := basepath.Parse(c.BasePath); err != nil {
		return err
	}
	if c.AuthMode != AuthModeToken && c.AuthMode != AuthModeProxy {
		return errors.New("auth mode must be token or proxy")
	}
	if c.Mode != ModeStandalone && c.Mode != ModeHosted {
		return errors.New("mode must be standalone or hosted")
	}
	if err := validateHostNavigationURL(c.HostNavigationURL); err != nil {
		return err
	}
	if c.Mode == ModeHosted {
		if strings.TrimSpace(c.WorkspaceRoot) == "" {
			return errors.New("hosted mode requires a workspace root")
		}
		if !filepath.IsAbs(c.WorkspaceRoot) {
			return errors.New("hosted mode workspace root must be absolute")
		}
		if strings.ToLower(strings.TrimSpace(c.Runtime)) != "codex" {
			return errors.New("hosted mode supports only the Codex runtime")
		}
		if c.AuthMode != AuthModeProxy {
			return errors.New("hosted mode requires proxy authentication")
		}
		if strings.TrimSpace(c.ProxyAuthHeader) == "" || strings.TrimSpace(c.AuthToken) == "" {
			return errors.New("hosted mode requires a proxy auth header and token")
		}
		if !filepath.IsAbs(c.StateRoot) {
			return errors.New("hosted mode state root must be absolute")
		}
	}
	return nil
}

func validateHostNavigationURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return errors.New("host navigation URL must be an absolute HTTP(S) URL or root-relative path")
	}
	if parsed.User != nil {
		return errors.New("host navigation URL must not contain credentials")
	}
	if parsed.IsAbs() {
		if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return errors.New("host navigation URL must be an absolute HTTP(S) URL or root-relative path")
		}
		return nil
	}
	if !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") {
		return errors.New("host navigation URL must be an absolute HTTP(S) URL or root-relative path")
	}
	return nil
}

type cleanupStack struct {
	fns []func()
}

func (s *cleanupStack) add(fn func()) {
	s.fns = append(s.fns, fn)
}

func (s *cleanupStack) close() {
	for i := len(s.fns) - 1; i >= 0; i-- {
		s.fns[i]()
	}
}
