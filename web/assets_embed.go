package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distEmbed embed.FS

// DistFS is the Vite build output rooted at "web/dist/", surfaced as if "/"
// were the dist directory. Run `npm --prefix web run build` before `go build` —
// otherwise the embed directive will fail at build time.
func DistFS() fs.FS {
	sub, err := fs.Sub(distEmbed, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
