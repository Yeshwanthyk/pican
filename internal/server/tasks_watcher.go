package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

const taskUpdateDebounce = 100 * time.Millisecond

type tasksWatcherState struct {
	mu      sync.Mutex
	watcher *fsnotify.Watcher
	targets map[string]string
	watched map[string]bool
}

func (s *Server) startTasksWatcher() {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		fmt.Fprintf(os.Stderr, "tasks watcher unavailable: %v\n", err)
		return
	}
	s.tasks.watcher = watcher
	s.tasks.targets = make(map[string]string)
	s.tasks.watched = make(map[string]bool)
	if info, err := os.Stat(s.globalTasksDir()); err == nil && info.IsDir() {
		s.tasks.targets[s.globalTasksDir()] = "global"
		s.addTasksWatch(s.globalTasksDir())
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer watcher.Close()
		s.runTasksWatcher(watcher)
	}()
}

func (s *Server) addTasksWatch(path string) {
	if s.tasks.watcher == nil || s.tasks.watched[path] {
		return
	}
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		if s.tasks.watcher.Add(path) == nil {
			s.tasks.watched[path] = true
		}
	}
}

func (s *Server) refreshTasksWatchesLocked(target string) {
	for path := target; ; path = filepath.Dir(path) {
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			s.addTasksWatch(path)
			return
		}
		parent := filepath.Dir(path)
		if parent == path {
			return
		}
	}
}

func (s *Server) watchTasksProject(project string) {
	s.tasks.mu.Lock()
	defer s.tasks.mu.Unlock()
	if s.tasks.watcher == nil {
		return
	}
	target := filepath.Join(project, ".pi", "tasks")
	s.tasks.targets[target] = project
	s.refreshTasksWatchesLocked(target)
	if info, err := os.Stat(s.globalTasksDir()); err == nil && info.IsDir() {
		s.tasks.targets[s.globalTasksDir()] = "global"
		s.addTasksWatch(s.globalTasksDir())
	}
}

func taskWatchEventAffects(target, name string) bool {
	target = filepath.Clean(target)
	name = filepath.Clean(name)
	if name == target {
		return true
	}
	if rel, err := filepath.Rel(target, name); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return true
	}
	return strings.HasPrefix(target, name+string(filepath.Separator))
}

func (s *Server) runTasksWatcher(watcher *fsnotify.Watcher) {
	updates := make(chan string, 16)
	timers := make(map[string]*time.Timer)
	defer func() {
		for _, timer := range timers {
			timer.Stop()
		}
	}()
	schedule := func(project string) {
		if timer := timers[project]; timer != nil {
			timer.Stop()
		}
		timers[project] = time.AfterFunc(taskUpdateDebounce, func() {
			select {
			case updates <- project:
			case <-s.stopCh:
			}
		})
	}
	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}
			if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Rename|fsnotify.Remove) == 0 {
				continue
			}
			s.tasks.mu.Lock()
			if event.Op&(fsnotify.Rename|fsnotify.Remove) != 0 {
				delete(s.tasks.watched, filepath.Clean(event.Name))
			}
			for target, project := range s.tasks.targets {
				if taskWatchEventAffects(target, event.Name) {
					s.refreshTasksWatchesLocked(target)
					schedule(project)
				}
			}
			s.tasks.mu.Unlock()
		case project := <-updates:
			delete(timers, project)
			msg, err := formatSSEJSONEvent("tasks-updated", map[string]string{"project": project})
			if err == nil {
				s.broadcast(globalSessID, msg)
			}
		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			fmt.Fprintf(os.Stderr, "tasks watcher: %v\n", err)
		case <-s.stopCh:
			return
		}
	}
}
