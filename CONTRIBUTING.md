# Contributing to pican

Thanks for your interest in contributing! pican is currently in an **early stage** of development, and we are not actively accepting pull requests right now.

## How to contribute

**Please open an issue first.** Whether it's a bug report, a feature idea, or a question — start with an issue so we can discuss it before any code is written.

- **Feature requests:** Create an issue describing what you'd like to see. I'll review it and let you know if it's something I want to include at this stage.
- **Bug reports:** File an issue with steps to reproduce, expected behavior, and what actually happened. I'll respond and triage from there.

If a feature or fix is something I decide to move forward with, I'll invite a pull request at that point.

## Development checks

Use `make build` rather than `go build`; the Go binary embeds the Vite frontend and static export. Before pushing, run `make check`. It covers Oxlint, Oxfmt and Svelte formatting, TypeScript plus `svelte-check`, Knip, unit tests, the production build, installer tests, and `go vet`. Browser flows run separately with `make e2e` after the one-time `make e2e-setup`.

Frontend browser I/O is Effect-backed. Components use the adapters in `web/src/lib/runtime.ts` and must not call `Effect.run*` directly. Because the repository pins an Effect 4 beta, consult the matching `effect-smol` source before writing or changing Effect code.

Thanks for understanding, and I appreciate you taking the time to help make pican better!
