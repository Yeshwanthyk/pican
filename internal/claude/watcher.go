package claude

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher debounces native Claude transcript changes. Per-file refreshes never
// prune; removals and directory changes request a complete catalog scan.
type Watcher struct {
	catalog  *Catalog
	fs       *fsnotify.Watcher
	debounce time.Duration
	onError  func(error)
	stop     chan struct{}
	done     chan struct{}
	once     sync.Once
	watched  map[string]struct{}
}

func (c *Catalog) Watch(debounce time.Duration, onError func(error)) (*Watcher, error) {
	if debounce <= 0 {
		debounce = 100 * time.Millisecond
	}
	fsWatcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	watcher := &Watcher{
		catalog: c, fs: fsWatcher, debounce: debounce, onError: onError,
		stop: make(chan struct{}), done: make(chan struct{}), watched: map[string]struct{}{},
	}
	if err := watcher.addAvailableDirectories(); err != nil {
		_ = fsWatcher.Close()
		return nil, err
	}
	go watcher.run()
	return watcher, nil
}

func (w *Watcher) Close() error {
	var err error
	w.once.Do(func() {
		close(w.stop)
		err = w.fs.Close()
		<-w.done
	})
	return err
}

func (w *Watcher) run() {
	defer close(w.done)
	ready := make(chan string, 128)
	timers := map[string]*time.Timer{}
	stopTimers := func() {
		for _, timer := range timers {
			timer.Stop()
		}
	}
	defer stopTimers()
	schedule := func(key string) {
		if timer := timers[key]; timer != nil {
			timer.Stop()
		}
		timers[key] = time.AfterFunc(w.debounce, func() {
			select {
			case ready <- key:
			case <-w.stop:
			}
		})
	}
	for {
		select {
		case <-w.stop:
			return
		case err, ok := <-w.fs.Errors:
			if !ok {
				return
			}
			w.report(err)
		case event, ok := <-w.fs.Events:
			if !ok {
				return
			}
			cleanPath := filepath.Clean(event.Name)
			if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
				if _, watchedDirectory := w.watched[cleanPath]; watchedDirectory {
					delete(w.watched, cleanPath)
					if err := w.addAvailableDirectories(); err != nil && !errors.Is(err, os.ErrNotExist) {
						w.report(err)
					}
					schedule("")
					continue
				}
			}
			if event.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(cleanPath); err == nil && info.IsDir() {
					if err := w.addAvailableDirectories(); err != nil {
						w.report(err)
					}
					schedule("")
					continue
				}
			}
			if filepath.Ext(cleanPath) != ".jsonl" {
				continue
			}
			if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
				schedule("")
				continue
			}
			if event.Op&(fsnotify.Create|fsnotify.Write) != 0 {
				schedule(cleanPath)
			}
		case key := <-ready:
			delete(timers, key)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			if key == "" {
				for pending, timer := range timers {
					timer.Stop()
					delete(timers, pending)
				}
				_, err := w.catalog.Sync(ctx)
				if err != nil {
					w.report(err)
				}
			} else {
				_, _, err := w.catalog.RefreshPath(ctx, key)
				if err != nil {
					w.report(err)
				}
			}
			cancel()
		}
	}
}

func (w *Watcher) addAvailableDirectories() error {
	if info, err := os.Stat(w.catalog.projectsDir); err == nil && info.IsDir() {
		if err := w.add(w.catalog.projectsDir); err != nil {
			return err
		}
		projects, err := os.ReadDir(w.catalog.projectsDir)
		if err != nil {
			return err
		}
		for _, project := range projects {
			if project.IsDir() && project.Type()&os.ModeSymlink == 0 {
				if err := w.add(filepath.Join(w.catalog.projectsDir, project.Name())); err != nil {
					return err
				}
			}
		}
		return nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Watching the config root lets a newly created projects directory become
	// observable without pican creating or mutating the Claude home itself.
	if info, err := os.Stat(w.catalog.home); err == nil && info.IsDir() {
		return w.add(w.catalog.home)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.ErrNotExist
}

func (w *Watcher) add(path string) error {
	path = filepath.Clean(path)
	if _, exists := w.watched[path]; exists {
		return nil
	}
	if err := w.fs.Add(path); err != nil {
		return err
	}
	w.watched[path] = struct{}{}
	return nil
}

func (w *Watcher) report(err error) {
	if err == nil || w.onError == nil {
		return
	}
	// fsnotify can report a path after a rename. Avoid leaking transcript
	// contents; errors carry only operation/path metadata.
	message := strings.TrimSpace(err.Error())
	if message != "" {
		w.onError(errors.New(message))
	}
}
