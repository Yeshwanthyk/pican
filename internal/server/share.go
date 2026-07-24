package server

import (
	"net/http"

	"pican/internal/sessions"
	"pican/internal/share"
)

// shareCmdRunner is overridable in tests so the share handler doesn't shell out.
type shareCmdRunner interface {
	authStatus() error
	createGist(htmlPath string) (string, string, error) // returns (stdout, stderr)
}

type shareRunnerAdapter struct{ runner shareCmdRunner }

func (a shareRunnerAdapter) AuthStatus() error { return a.runner.authStatus() }
func (a shareRunnerAdapter) CreateGist(htmlPath string) (string, string, error) {
	return a.runner.createGist(htmlPath)
}

func (s *Server) handleShare(w http.ResponseWriter, r *http.Request) {
	var runner share.Runner
	if s.shareRunner != nil {
		runner = shareRunnerAdapter{runner: s.shareRunner}
	}
	share.Handle(w, r, share.Dependencies{
		Runner: runner,
		Resolve: func(id string) (sessions.Session, error) {
			resolved, err := s.resolveSession(id)
			if err != nil {
				return sessions.Session{}, err
			}
			return resolved.Session, nil
		},
		RenderExport: s.renderExportSession,
	})
}
