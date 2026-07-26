package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"
)

func serveUntilCanceled(ctx context.Context, server *http.Server, listener net.Listener) error {
	waitCtx, stopWait := context.WithCancel(context.Background())
	defer stopWait()
	go func() {
		select {
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = server.Shutdown(shutdownCtx)
			_ = listener.Close()
		case <-waitCtx.Done():
		}
	}()

	err := server.Serve(listener)
	if ctx.Err() != nil && (errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed)) {
		return nil
	}
	return err
}
