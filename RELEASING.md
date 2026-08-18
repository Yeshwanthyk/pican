# Releasing pican

Releases are cut **locally** — there is no CI for now. Every release:

1. Updates `CHANGELOG.md` (move `[Unreleased]` entries into a new `[x.y.z]`
   section dated today, per [Keep a Changelog](https://keepachangelog.com)).
2. Bumps the `version` field in `package.json`.
3. Builds the four platform binaries with the release version baked in.
4. Publishes a GitHub release tagged `v<version>` with the binaries and
   `sha256sums.txt`.

The in-app updater and `/pican update` download `pican-<os>-<arch>` from
`https://github.com/Yeshwanthyk/pican/releases/latest/download/<asset>`, verify
the sha256 against `sha256sums.txt`, and atomically replace the running binary.

## Steps

### 1. Version + changelog

```bash
# pick the new version (semver, "v"-prefix on the tag)
VERSION=0.0.6
```

- Add a `## [0.0.6] - <date>` section to `CHANGELOG.md` and move the
  `[Unreleased]` entries into it. Never drop an entry; if nothing is
  unreleased yet, the section stays empty until there is something to ship.
- Set `"version": "0.0.6"` in `package.json`.

Commit both:

```bash
git add CHANGELOG.md package.json
git commit -m "chore: release v${VERSION}"
```

### 2. Build the release binaries

```bash
# frontend assets must be current (embedded into the binary)
make frontend-build

mkdir -p dist-release
for target in "darwin amd64" "darwin arm64" "linux amd64" "linux arm64"; do
  set -- $target
  CGO_ENABLED=0 GOOS=$1 GOARCH=$2 \
    go build -ldflags="-s -w -X main.version=v${VERSION}" \
    -o dist-release/pican-$1-$2 ./cmd/pican
done
cd dist-release && shasum -a 256 pican-* > sha256sums.txt
```

Sanity check on the host platform (macOS arm64 here):

```bash
./dist-release/pican-darwin-arm64 -version   # → v0.0.6
```

### 3. Publish

```bash
gh release create v${VERSION} \
  dist-release/pican-darwin-amd64 \
  dist-release/pican-darwin-arm64 \
  dist-release/pican-linux-amd64 \
  dist-release/pican-linux-arm64 \
  dist-release/sha256sums.txt \
  --title "pican v${VERSION}" \
  --notes "See CHANGELOG.md"
```

### 4. Verify

```bash
# API returns the new tag + assets
curl -s https://api.github.com/repos/Yeshwanthyk/pican/releases/latest \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['tag_name'], [a['name'] for a in d['assets']])"

# download + checksum check
curl -fsSL -o /tmp/pican-new \
  https://github.com/Yeshwanthyk/pican/releases/download/v${VERSION}/pican-darwin-arm64
curl -fsSL -o /tmp/sha256sums.txt \
  https://github.com/Yeshwanthyk/pican/releases/download/v${VERSION}/sha256sums.txt
cd /tmp && shasum -a 256 -c sha256sums.txt 2>/dev/null | grep darwin-arm64
```

### 5. Update an installed copy

```bash
cp dist-release/pican-darwin-arm64 ~/.pi/agent/bin/pican && chmod +x ~/.pi/agent/bin/pican
```

(When a newer release exists, the in-app **Update & Restart** button and the
`/pican update` command perform this step automatically.)

## Version reporting

`main.version` is set at build time via `-ldflags "-X main.version=..."`.
Release builds report the tag exactly (e.g. `v0.0.6`) so the updater's semver
comparison and `isDev` detection behave correctly. Local `make build` uses
`git describe` output (e.g. `v0.0.5-2-gabc1234-dirty`), which the updater
treats as a dev build — in-app update stays disabled for dev binaries by
design.
