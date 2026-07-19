package main

import "pican/internal/app"

// version is set at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	app.Main(version)
}
