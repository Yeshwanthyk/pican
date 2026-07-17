package server

import "time"

func (s *Server) sweepStatusOnce() {
	s.lastKnownMu.Lock()
	ids := make([]string, 0, len(s.lastKnown))
	for id := range s.lastKnown {
		ids = append(ids, id)
	}
	s.lastKnownMu.Unlock()

	for _, id := range ids {
		s.recomputeAndBroadcastStatus(id)
	}
}

func (s *Server) runStatusSweeper(stop <-chan struct{}, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.sweepStatusOnce()
		case <-stop:
			return
		}
	}
}
