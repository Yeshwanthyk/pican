package app

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"pi-web/internal/rpc"
)

// Spawning `pi --mode rpc` to enumerate models takes seconds, but the list
// rarely changes. Cache it with a TTL and coalesce concurrent callers so each
// session-detail page load doesn't pay the subprocess cost.

const modelsCacheTTL = 5 * time.Minute

type modelsCacheEntry struct {
	data json.RawMessage
	at   time.Time
}

type modelsCache struct {
	mu      sync.Mutex
	entry   *modelsCacheEntry
	pending chan struct{}
	pendErr error
	pendRes json.RawMessage
}

var defaultModelsCache = &modelsCache{}

func (c *modelsCache) get(ctx context.Context) (json.RawMessage, error) {
	c.mu.Lock()
	if c.entry != nil && time.Since(c.entry.at) < modelsCacheTTL {
		data := c.entry.data
		c.mu.Unlock()
		return data, nil
	}
	if c.pending != nil {
		wait := c.pending
		c.mu.Unlock()
		select {
		case <-wait:
			c.mu.Lock()
			res, err := c.pendRes, c.pendErr
			c.mu.Unlock()
			return res, err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	done := make(chan struct{})
	c.pending = done
	c.mu.Unlock()

	// Use a background context so a cancelled caller doesn't kill the shared
	// subprocess for everyone else; cap it ourselves.
	fetchCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	data, err := rpc.OneShot(fetchCtx, "get_available_models", nil)
	cancel()

	c.mu.Lock()
	c.pendRes, c.pendErr = data, err
	if err == nil {
		c.entry = &modelsCacheEntry{data: data, at: time.Now()}
	}
	c.pending = nil
	close(done)   // signal waiters while still holding the lock so no new fetch
	c.mu.Unlock() // can race in and overwrite pendRes/pendErr before they read

	if err != nil {
		return nil, err
	}
	// Respect the caller's context if it was cancelled while we were fetching.
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return data, nil
}

func warmModelsCache() {
	go func() {
		_, _ = defaultModelsCache.get(context.Background())
	}()
}
