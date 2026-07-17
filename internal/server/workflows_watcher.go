package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

const workflowUpdateDebounce = 100 * time.Millisecond

func (s *Server) startWorkflowsWatcher() {
	if err := s.startWorkflowsFsnotify(); err != nil {
		fmt.Fprintf(os.Stderr, "workflows watcher unavailable, falling back to polling: %v\n", err)
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.watchWorkflowsPolling()
		}()
	}
}

func (s *Server) broadcastWorkflowUpdate(runID string) {
	if !workflowRunIDPattern.MatchString(runID) {
		return
	}
	msg, err := formatSSEJSONEvent("workflows-updated", map[string]string{"runId": runID})
	if err == nil {
		s.broadcast(globalSessID, msg)
	}
}

func addWorkflowRunWatches(w *fsnotify.Watcher, workflowsDir string) {
	entries, err := os.ReadDir(workflowsDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() && workflowRunIDPattern.MatchString(entry.Name()) {
			_ = w.Add(filepath.Join(workflowsDir, entry.Name()))
		}
	}
}

func (s *Server) startWorkflowsFsnotify() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := w.Add(s.agentDir); err != nil {
		_ = w.Close()
		return err
	}
	workflowsDir := s.workflowsDir()
	if info, err := os.Stat(workflowsDir); err == nil && info.IsDir() {
		_ = w.Add(workflowsDir)
		addWorkflowRunWatches(w, workflowsDir)
	}

	type pendingUpdate struct {
		runID      string
		generation uint64
	}
	updates := make(chan pendingUpdate, 16)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer w.Close()
		timers := make(map[string]*time.Timer)
		generations := make(map[string]uint64)
		defer func() {
			for _, timer := range timers {
				timer.Stop()
			}
		}()
		schedule := func(runID string) {
			if !workflowRunIDPattern.MatchString(runID) {
				return
			}
			if timer := timers[runID]; timer != nil {
				timer.Stop()
			}
			generations[runID]++
			generation := generations[runID]
			timers[runID] = time.AfterFunc(workflowUpdateDebounce, func() {
				select {
				case updates <- pendingUpdate{runID: runID, generation: generation}:
				case <-s.stopCh:
				}
			})
		}

		for {
			select {
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if ev.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Rename|fsnotify.Remove) == 0 {
					continue
				}
				if filepath.Clean(ev.Name) == filepath.Clean(workflowsDir) {
					if info, err := os.Stat(workflowsDir); err == nil && info.IsDir() {
						_ = w.Add(workflowsDir)
						addWorkflowRunWatches(w, workflowsDir)
						if entries, err := os.ReadDir(workflowsDir); err == nil {
							for _, entry := range entries {
								if entry.IsDir() {
									schedule(entry.Name())
								}
							}
						}
					}
					continue
				}
				rel, err := filepath.Rel(workflowsDir, ev.Name)
				if err != nil || rel == "." || filepath.IsAbs(rel) {
					continue
				}
				parts := strings.Split(filepath.ToSlash(rel), "/")
				if len(parts) == 1 && workflowRunIDPattern.MatchString(parts[0]) {
					if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
						_ = w.Add(ev.Name)
					}
					schedule(parts[0])
					continue
				}
				if len(parts) >= 2 {
					schedule(parts[0])
				}
			case update := <-updates:
				if generations[update.runID] != update.generation {
					continue
				}
				delete(timers, update.runID)
				delete(generations, update.runID)
				s.broadcastWorkflowUpdate(update.runID)
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				fmt.Fprintf(os.Stderr, "workflows watcher: %v\n", err)
			case <-s.stopCh:
				return
			}
		}
	}()
	return nil
}

func (s *Server) watchWorkflowsPolling() {
	ticker := time.NewTicker(1500 * time.Millisecond)
	defer ticker.Stop()
	known := make(map[string]time.Time)
	for {
		select {
		case <-ticker.C:
			seen := make(map[string]bool)
			entries, err := os.ReadDir(s.workflowsDir())
			if err != nil {
				continue
			}
			for _, entry := range entries {
				if !entry.IsDir() || !workflowRunIDPattern.MatchString(entry.Name()) {
					continue
				}
				runID := entry.Name()
				seen[runID] = true
				latest := time.Time{}
				files, _ := os.ReadDir(filepath.Join(s.workflowsDir(), runID))
				for _, file := range files {
					if info, err := file.Info(); err == nil && info.ModTime().After(latest) {
						latest = info.ModTime()
					}
				}
				previous, exists := known[runID]
				known[runID] = latest
				if !exists || latest.After(previous) {
					s.broadcastWorkflowUpdate(runID)
				}
			}
			for runID := range known {
				if !seen[runID] {
					delete(known, runID)
					s.broadcastWorkflowUpdate(runID)
				}
			}
		case <-s.stopCh:
			return
		}
	}
}
