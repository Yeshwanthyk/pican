package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"pican/internal/app"
)

// version is set at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	config, showVersion, err := app.ParseCLI(os.Args[1:], version, os.Stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		os.Exit(2)
	}
	if showVersion {
		fmt.Println(version)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := app.Run(ctx, config); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
