# `pican` Design System Specification

This document details the core design system for `pican`. The design system is styled purely using standard **CSS Custom Properties** (Variables). This design system is responsive, highly performant, handles instant client-side transitions, and permits deep user customizability.

---

## 1. Core Principles

1. **Monospace Typography:** Highly tailored to developer workflows, using a clean monospace typeface stack.
2. **Obsidian Obsidian Dark by Default:** Provides a premium, high-contrast visual footprint that is comfortable for long hours of pairing.
3. **Fully Semantic Visual Tokens:** No hardcoded hex values in CSS rules or component styles. Every color, border, padding, and layout attribute references semantic tokens. (Note: `<meta name="theme-color">` requires a literal color value and is the sole exception.)
4. **Zero Compilation Overhead:** Themes are resolved purely at runtime by the browser, removing the need for server-side CSS precompilation.
5. **Local Custom Themes:** Anyone can configure custom themes by adding a simple CSS stylesheet in their active configuration directory.

---

## 2. Built-in Premium Themes

`pican` packages four highly polished, built-in themes out of the box:

### A. Carbon/Obsidian Dark (`[data-theme="dark"]`)
- **Theme Color:** `#0e0e13` / `#111116`
- **Contrast Style:** Deep black-zinc background with teal highlights (`#9cc7c0`). Emits a clean, developer-focused, distraction-free environment.

### B. Warm Linen Light (`[data-theme="light"]`)
- **Theme Color:** `#f6f5f2`
- **Contrast Style:** Soft, warm linen background with dark charcoal text (`#1f2328`) and warm pine-green accent indicators (`#496f69`). Avoids high-glare blinding whites.

### C. Arctic Frost Nord (`[data-theme="nord"]`)
- **Theme Color:** `#2e3440`
- **Contrast Style:** A beautifully balanced slate-polar color scheme inspired by Nord, emphasizing crisp cyan highlights (`#88c0d0`) and cool blue borders (`#81a1c1`).

### D. Cyberpunk Dracula (`[data-theme="dracula"]`)
- **Theme Color:** `#282a36`
- **Contrast Style:** High-contrast cyberpunk palette, utilizing vibrant neon pink (`#ff79c6`), light green (`#50fa7b`), and soft violet (`#bd93f9`).

---

## 2b. Community Themes

Ten additional themes ported from popular VS Code color themes, available from the theme picker in **Settings → Appearance** (not part of the `⌘⇧L` quick-cycle, which stays on the five themes above plus `custom`). Each derives its full token set — surfaces, syntax highlighting, diff colors, markdown accents — from the source theme's `colors`/`tokenColors`, following the same token taxonomy as the built-in themes above.

| Theme | `data-theme` | Style | Accent |
| --- | --- | --- | --- |
| Catppuccin Mocha | `catppuccin-mocha` | Soft pastel dark | `#89b4fa` |
| Catppuccin Latte | `catppuccin-latte` | Soft pastel light | `#1e66f5` |
| Gruvbox Dark | `gruvbox-dark` | Warm retro-contrast dark | `#83a598` |
| Tokyo Night | `tokyo-night` | Cool neon-city dark | `#7aa2f7` |
| Rosé Pine | `rose-pine` | Muted rose/pine dark | `#c4a7e7` |
| GitHub Dark | `github-dark` | GitHub's default dark | `#2f81f7` |
| GitHub Light | `github-light` | GitHub's default light | `#0969da` |
| One Dark Pro | `one-dark-pro` | Atom's classic dark | `#61afef` |
| Everforest Dark | `everforest-dark` | Warm forest-green dark | `#a7c080` |
| Kanagawa Wave | `kanagawa-wave` | Japanese ink-painting dark | `#7e9cd8` |

---

## 3. Dynamic Custom Themes

You can inject **your own themes** into `pican`!

### How It Works Under the Hood
1. The server checks for the file `~/.pi/agent/pican/custom-themes.css` on every page request.
2. If it exists, the Go server automatically appends a stylesheet link:
   ```html
   <link rel="stylesheet" href="/custom-themes.css">
   ```
3. You can define any theme block utilizing a `[data-theme="custom"]` (or any custom identifier) selector to override color schemes!

### Example: Setting Up a Custom Theme
Create `~/.pi/agent/pican/custom-themes.css` and paste the following structure:

```css
[data-theme="custom"] {
    /* ── Main Canvas ── */
    --body-bg: #1e1e1e;
    --surface: #252526;
    --surface-2: #2d2d30;
    --text: #d4d4d4;
    --text-soft: #aaaaaa;
    --dim: #3e3e42;
    --accent: #007acc;
    --border-accent: #007acc;
    
    /* ── Syntax Overrides ── */
    --syntaxKeyword: #569cd6;
    --syntaxString: #ce9178;
    --syntaxComment: #6a9955;
    
    /* ... you can override any design system token listed below! */
}
```

Once saved, reload the page and open the **Session Actions menu (⋯)** in the top-right of the session header, then cycle through the **Theme** toggle until **⚙ Custom** appears.

---

## 4. Design Tokens Manifest

Every component (the index list cards, sidebar tree, chat bubbles, buttons, and command palette) uses this unified variable taxonomy:

### Colors & Surfaces
- `--body-bg`: Main screen canvas background.
- `--surface`: Background of primary cards, panels, and sheets.
- `--surface-2`: Hovers, action lists, active states.
- `--text`: High-contrast body and title copy.
- `--text-soft`: Lower contrast descriptive labels.
- `--muted`: Extremely low-emphasis metadata.
- `--dim`: Outer dividing rules and borders.
- `--dim-2`: Inner subtle divisions.
- `--accent`: Brand focus, highlight borders, and state changes.
- `--attention`: Waiting-for-user and other non-error states that need action.

### Syntax Highlighting & Diffs
- `--syntaxKeyword`: Language keywords.
- `--syntaxComment`: Code comments.
- `--syntaxString`: String literals.
- `--toolDiffAdded`: Inline git addition rows.
- `--toolDiffRemoved`: Inline git deletion rows.

### Common Components
- **Buttons (`.btn-primary`, `.btn-secondary`):**
  - Rounded borders: `6px`.
  - Margin padding: `8px 14px`.
  - Inherited color-transitions: `0.12s ease`.
- **Inputs (`input[type="text"]`):**
  - Soft-shadow focus rings mapping `--accent`.
  - Complete padding alignment with adjacent buttons.

### Session Transcript

- User and assistant turns are prose-first: compact role labels establish authorship, user copy carries stronger weight, and assistant prose uses a 13.5px/1.65 reading rhythm capped at 72 characters.
- Thinking and tool execution live in one Activity disclosure per turn. Its neutral left hairline indicates hierarchy rather than status; running state uses `--attention`, while failures use the existing error token.
- Edit tools render unified rows with tabular old/new line numbers. Added and removed rows use a 7% semantic tint, while paired intra-line changes use a 28% highlight derived from the same diff token.
- Transcript disclosures and actions use named 120ms transitions, 40px desktop targets, and 44px mobile targets. Each text message exposes a copy-content action with short success/failure feedback; the separate link action copies its deep link. The streaming caret stops blinking under reduced-motion preferences.

### Sessions Index

- Sessions render as flat ticker rows separated by hairlines. The title leads, current activity or waiting state follows when present, and the footer balances project/model against token, cost, and recency metrics.
- Live and waiting sessions move into a `Now` group and are excluded from pinned/date groups below it. Waiting uses `--attention`; live work uses `--accent` and a reduced-motion-safe status pulse.
- Desktop uses a compact top action bar and a right rail for waiting questions, schedules, and machines. Mobile uses a bottom thumb bar with search, a 46px new-session action, and the overflow menu.
- Counts, costs, tokens, elapsed durations, and timestamps use tabular numerals. All fourteen named themes define `--attention` independently from danger and success.

### Plain States

- First-run and empty-search states use one centered muted line plus one dim hint line. They don't use cards, glyphs, or apology copy; the hint states the immediate fix.
- The live chat composer uses explicit routing verbs. Idle shows `Send`; a steerable running turn separates quiet `Stop` from primary `Steer now` and secondary `Queue next`. Queue/steer rows include `queued next` or `submitted` plus a tabular timestamp. Native interrupt acknowledgement displays `stopping` until authoritative idle and prevents repeated Stop clicks.
- A crashed worker adds a danger line at the end of the saved transcript with the process exit code, a saved-transcript hint, a `worker down` header substate, and a disabled composer. Any active streaming caret turns danger and stops blinking.
- A view-only session replaces the composer with a centered `view only · resume in terminal: …` copy target and adds an attention-colored `view only` header substate.
- Plain-state metrics and exit codes use tabular numerals. Interactive copy targets keep 40px desktop and 44px mobile minimum heights, a named 120ms color/transform transition, and `scale(0.96)` press feedback.
