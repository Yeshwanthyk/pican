package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

const defaultCatalogEventDebounce = 100 * time.Millisecond

type CatalogEventCallbacks struct {
	Projection func(Projection)
	Error      func(error)
}

type catalogEventKey struct {
	nativeID  string
	directory string
}

// CatalogEvents coalesces the shared native event stream into authoritative
// reads. Per-session refresh never prunes; deletion requests a full catalog
// reconciliation, whose own complete/partial contract controls pruning.
type CatalogEvents struct {
	catalog  *Catalog
	debounce time.Duration
	callback CatalogEventCallbacks

	mu      sync.Mutex
	pending map[catalogEventKey]struct{}
	full    bool
	timer   *time.Timer
	closed  bool
	wg      sync.WaitGroup
}

func NewCatalogEvents(catalog *Catalog, debounce time.Duration, callback CatalogEventCallbacks) (*CatalogEvents, error) {
	if catalog == nil {
		return nil, errors.New("OpenCode catalog events require a catalog")
	}
	if debounce <= 0 {
		debounce = defaultCatalogEventDebounce
	}
	return &CatalogEvents{
		catalog: catalog, debounce: debounce, callback: callback,
		pending: make(map[catalogEventKey]struct{}),
	}, nil
}

func (c *CatalogEvents) HandleEvent(event Event) {
	nativeID := event.SessionID()
	if nativeID == "" || !catalogRefreshEvent(event) {
		return
	}
	directory, err := CanonicalDirectory(event.Directory)
	if err != nil {
		c.report(fmt.Errorf("validate OpenCode event directory: %w", err))
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	if event.Payload.Type == "session.deleted" {
		c.full = true
	} else {
		c.pending[catalogEventKey{nativeID: nativeID, directory: directory}] = struct{}{}
	}
	if c.timer == nil {
		c.timer = time.AfterFunc(c.debounce, c.flush)
	} else {
		c.timer.Reset(c.debounce)
	}
}

func catalogRefreshEvent(event Event) bool {
	switch event.Payload.Type {
	case "session.created", "session.updated", "session.deleted", "session.idle",
		"message.updated", "message.part.updated":
		return true
	case "session.status":
		var value struct {
			Status SessionStatus `json:"status"`
		}
		if json.Unmarshal(event.Payload.Properties, &value) != nil {
			return false
		}
		return value.Status.Type == "idle"
	default:
		return false
	}
}

func (c *CatalogEvents) flush() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	pending := c.pending
	full := c.full
	c.pending = make(map[catalogEventKey]struct{})
	c.full = false
	c.timer = nil
	c.wg.Add(1)
	c.mu.Unlock()

	defer c.wg.Done()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if full {
		if _, err := c.catalog.Sync(ctx); err != nil {
			c.report(fmt.Errorf("reconcile deleted OpenCode session: %w", err))
		}
		return
	}
	for key := range pending {
		projection, err := c.catalog.RefreshSession(ctx, key.nativeID, key.directory)
		if err != nil {
			c.report(fmt.Errorf("refresh OpenCode session %s: %w", key.nativeID, err))
			continue
		}
		if c.callback.Projection != nil {
			c.callback.Projection(projection)
		}
	}
}

func (c *CatalogEvents) report(err error) {
	if err != nil && c.callback.Error != nil {
		c.callback.Error(err)
	}
}

func (c *CatalogEvents) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	c.pending = nil
	c.mu.Unlock()
	c.wg.Wait()
}
