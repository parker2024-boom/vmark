---
paths:
  - "**/*.css"
  - "src/**/*.tsx"
  - "src/theme/**"
  - "src/styles/**"
  - "src/hooks/useTheme.ts"
  - "src/shell/**"
---

# 31 - Design Tokens

Reference for CSS custom properties. Always use tokens over hardcoded values.

**Source of truth (post-ADR-014, `.claude/adr/ADR-014-theme-tokens-as-typed-data.md`):**
- Typed theme catalog: `src/theme/themes/<id>.ts` (paper, white, mint, sepia, night, solarized) implementing `ThemeTokens` from `src/theme/tokens.ts`.
- Runtime CSS-var writer: `src/theme/applyTheme.ts` (emits `--color-*`, `--space-*`, etc. for the typed pathway).
- Legacy CSS-var values (the `--bg-color` / `--accent-bg` / `--alert-note` names the app's CSS actually consumes) also flow from the typed catalog: the per-theme dark overrides live on `ThemeTokens.color.legacy` (night, solarized), and the shared light-mode statics live in `legacyLight` (`src/theme/tokens.ts`). `useTheme.ts` reads both from the catalog — it no longer carries its own `darkModeColors`/`lightModeColors` literals.
- Dynamic per-user overrides (font size, line-height, editor width) are still computed in `src/hooks/useTheme.ts`; static fallbacks remain in `src/styles/index.css`.

Adding/retinting a theme is a single-file edit in `src/theme/themes/` (plus
appending the ID to `themes/index.ts` and the `ThemeId` union). The table
below mirrors the runtime CSS-var names that consumers see; the
authoritative values for those names live in the typed catalog.

## Core Color Tokens

| Token | Purpose | Light Default |
|-------|---------|---------------|
| `--bg-color` | Main background | `#eeeded` |
| `--bg-primary` | Alias for `--bg-color` | - |
| `--bg-secondary` | Secondary surfaces | `#e5e4e4` |
| `--bg-tertiary` | Hover backgrounds | `#f0f0f0` |
| `--hover-bg` | Explicit hover state (retuned 4%→6%, audit 20260901 WI-UA5 — 4% was below perception on grey card surfaces) | `rgba(0,0,0,0.06)` |
| `--hover-bg-strong` | Stronger hover | `rgba(0,0,0,0.08)` |
| `--hover-bg-dark` | Dark mode hover | `rgba(255,255,255,0.08)` |
| `--subtle-bg` | Very subtle background (retuned with WI-UA5) | `rgba(0,0,0,0.03)` |
| `--subtle-bg-hover` | Subtle background hover | `rgba(0,0,0,0.04)` |
| `--surface-raised` | Elevated control face — the `.vm-btn` BASE since WI-UB1 (debuted as the welcome variant, WI-UA13); white on light themes, lifted `#383d46` under `.dark-theme` | `#ffffff` |
| `--cursor-interactive` | D7 cursor, platform-scoped (WI-UA15): `default` on macOS, `pointer` under `.platform-windows`/`.platform-linux` (root class set by `main.tsx` from `platformRootClass()`) | `default` |
| `--text-color` | Primary text | `#1a1a1a` |
| `--text-primary` | Alias for `--text-color` | - |
| `--text-secondary` | Secondary text | `#666666` |
| `--text-tertiary` | Disabled/muted text | `#999999` |
| `--primary-color` | Links, primary actions — static ALIAS of `--accent-primary` (WI-UA7); the runtime emits both from one catalog value | `var(--accent-primary)` |
| `--border-color` | Borders, dividers | `#d5d4d4` |
| `--control-border` | Control boundary (≥ 3:1 on primary+secondary, D8) — never a divider | `#7e7d7d` |
| `--selection-color` | Text selection | `rgba(0,102,204,0.2)` |
| `--quote-text` | Blockquote body ink (readable prose — R5/WI-UI1.3) | `var(--text-secondary)` |
| `--contrast-text` | Text on colored backgrounds | `white` |

## Accent Tokens (Selection/Active States)

| Token | Purpose | Light Default |
|-------|---------|---------------|
| `--accent-primary` | Active icon/text color | `#0066cc` |
| `--accent-bg` | Active/selected background | `rgba(0,102,204,0.1)` |

**Rule (R6 — selection keeps its ink)**: Use `--accent-bg` for all selected/active
backgrounds, with `--text-color` for the row's TEXT and `--accent-primary` for
icons and indicators only. Accent-coloured text on the accent tint measures
3.84:1 on paper — below AA — which is why the older "accent-primary for text"
wording was retired. The current-tab idiom is the NEGATIVE treatment since
2026-09-02 (WI-UC1): ink and page swap tokens (`--text-color` fill,
`--bg-color` text), AA by construction on every theme — a named exception
carrying `ui-ok(state): current-tab`. Inside the ink face, page ink carries
the signals (dirty dot, focus bar, close affordance).

**Font roles (R3, WI-UI2.1)**: `--font-sans` is the READING font — the user's
choice, written from settings by `useTheme.ts`, consumed only under document
selectors. Chrome uses `--font-ui` (static system stack) so the UI never
restyles when the reading font changes. `--font-ui` is declared in `:root` and
the C5 check of `lint:ui-consistency` enforces the split at a zero baseline —
a chrome `--font-sans` site fails the gate.

**Tertiary is decorative (R5/D3)**: `--text-tertiary` never colours readable
text or an enabled control — it is the disabled/decorative tier (its rule-31
row has always said "Disabled/muted text"). Readable secondary content uses
`--text-secondary`.

**Arriving control tokens**: `--control-border` (D8) landed with WI-UI1.2 —
use it for any boundary that makes a control findable; `--border-color` stays a
divider. `--target-min` (24px hit-target floor, D2) landed with WI-UI2.3 —
no interactive element takes a smaller hit box; paint-small controls centre a
`--target-min` square over themselves with a `::before` expander (see
`icon-button-shared.css`).

## Semantic Tokens

| Token | Purpose | Light Default |
|-------|---------|---------------|
| `--error-color` | Error states | `#cf222e` |
| `--error-color-hover` | Error hover state | `#b91c1c` |
| `--error-bg` | Error background | `#ffebe9` |
| `--warning-color` | Warning states | `#9a6700` |
| `--warning-bg` | Warning background | `rgba(245,158,11,0.1)` |
| `--warning-border` | Warning borders | `rgba(245,158,11,0.3)` |
| `--success-color` | Success states | `#16a34a` |
| `--success-color-hover` | Success hover state | `#15803d` |
| `--success-color-dark` | Success states (dark mode) | `#4ade80` |

## Alert Block Colors

| Token | Purpose | Default |
|-------|---------|---------|
| `--alert-note` | Note blocks | `#0969da` |
| `--alert-tip` | Tip blocks | `#1a7f37` |
| `--alert-important` | Important blocks | `#8250df` |
| `--alert-warning` | Warning blocks | `#9a6700` |
| `--alert-caution` | Caution blocks | `var(--error-color)` |

### Dark Mode Alert Tokens

| Token | Value | Use For |
|-------|-------|---------|
| `--alert-note-dark` | `#58a6ff` | Note blocks in dark mode |
| `--alert-tip-dark` | `#3fb950` | Tip blocks in dark mode |
| `--alert-important-dark` | `#a371f7` | Important blocks in dark mode |
| `--alert-warning-dark` | `#d29922` | Warning blocks in dark mode |
| `--alert-caution-dark` | `#f85149` | Caution blocks in dark mode |

## Media Type Colors

| Token | Purpose | Default |
|-------|---------|---------|
| `--media-video` | Video media tags | `#0d9488` |
| `--media-audio` | Audio media tags | `#6366f1` |
| `--media-youtube` | YouTube media tags | `#dc2626` |
| `--media-vimeo` | Vimeo media tags | `#00adef` |
| `--media-bilibili` | Bilibili media tags | `#fb7299` |

### Dark Mode Media Tokens

| Token | Value | Use For |
|-------|-------|---------|
| `--media-video-dark` | `#2dd4bf` | Video in dark mode |
| `--media-audio-dark` | `#818cf8` | Audio in dark mode |
| `--media-youtube-dark` | `#f87171` | YouTube in dark mode |
| `--media-vimeo-dark` | `#4ac3f0` | Vimeo in dark mode |
| `--media-bilibili-dark` | `#fc9cb5` | Bilibili in dark mode |

## Syntax Tokens

| Family | Tokens | Use For |
|---|---|---|
| Syntax palette (per theme via `ThemeTokens.syntax`, D11) | `--syntax-keyword`, `--syntax-type`, `--syntax-function`, `--syntax-property`, `--syntax-variable`, `--syntax-string`, `--syntax-number`, `--syntax-operator`, `--syntax-punctuation`, `--syntax-comment`, `--syntax-escape`, `--syntax-constant`, `--syntax-attribute`, `--syntax-tag`, `--syntax-link`, `--syntax-invalid` | Code highlighting in Source mode (`source-syntax.css`), WYSIWYG code blocks (`hljs-syntax.css`) and data trees (`json-view-theme.css`). Every value clears 4.5:1 on bg.primary AND bg.secondary (C1e). |

## Highlight Tokens

| Token | Purpose | Default |
|-------|---------|---------|
| `--highlight-bg` | Highlight mark background | `#fff3a3` |
| `--highlight-text` | Highlight text color | `inherit` |

## Multi-cursor Tokens

| Token | Purpose | Light Default | Dark Override |
|-------|---------|---------------|---------------|
| `--multi-cursor-color` | Secondary cursor caret color | `hsl(217 91% 60%)` | `hsl(217 91% 70%)` |
| `--multi-cursor-selection-bg` | Secondary cursor selection background | `hsla(217, 91%, 60%, 0.3)` | `hsla(217, 91%, 70%, 0.25)` |

## Search & Divergence Tokens

| Token | Purpose | Light Default | Dark Override |
|-------|---------|---------------|---------------|
| `--search-match-color` | Find-bar match highlight | `rgba(255, 180, 0, 0.8)` | `rgba(255, 200, 0, 0.7)` |
| `--search-match-active-color` | Active find-bar match | `rgba(255, 200, 0, 0.7)` | `rgba(255, 200, 0, 0.5)` |
| `--divergent-border-dark` | Split-view divergence border (dark themes) | — | `rgba(0, 136, 255, 0.25)` |

## Spacing Tokens

| Token | Value | Use For |
|-------|-------|---------|
| `--spacing-1` | `4px` | Small gaps, tight padding |
| `--spacing-2` | `8px` | Standard gaps |
| `--spacing-3` | `12px` | Larger spacing |

**Use `--spacing-*` for `padding`, `margin`, and `gap` only.** A border-radius is a `--radius-*` token, never `--spacing-1`. The numeric value coincidence does not imply semantic equivalence — see "Tokenize value vs. tokenize intent" below.

## Icon Size Tokens

| Token | Value | Use For |
|-------|-------|---------|
| `--icon-size-sm` | `24px` | Bar buttons (`.vm-icon-btn--sm`); also the D2 hit-target floor |
| `--icon-size-md` | `26px` | Popup action buttons |
| `--icon-size-lg` | `28px` | Toolbar buttons |
| `--target-min` | `24px` | Minimum clickable square (D2); `::before` expanders consume it |

## List Tokens

| Token | Value | Use For |
|-------|-------|---------|
| `--list-indent` | `1em` | Global list indent base |

## Editor Content Tokens

| Token | Value | Use For |
|-------|-------|---------|
| `--editor-content-padding` | `fontSize * 2` (px) | Horizontal padding for editor content (constrains selection highlight). Computed dynamically in `useTheme.ts` to ensure consistency across WYSIWYG and Source modes. |

## Size Tokens

### Border Radius

| Token | Value | Use For |
|-------|-------|---------|
| `--radius-sm` | `3px` | Controls: buttons, icon squares, selects, field inputs, chips — and rows INSIDE floating surfaces (near-concentric) |
| `--radius-md` | `5px` | Content blocks (code, alerts, details…) and page/panel rows |
| `--radius-lg` | `8px` | Floating surfaces: popups, dialogs, menus, dropdowns |
| `--radius-pill` | `100px` | Pill shapes, tags, `.vm-btn--pill` capsule buttons |

**The φ curvature ladder (2026-09-02)**: window `21` → shell card `13` →
`--radius-lg 8` → `--radius-md 5` → `--radius-sm 3` — each step ≈ ×0.62
(Fibonacci: 3, 5, 8, 13, 21). Pick radius by TIER, never by taste; pills and
circles stay off-ladder. Bare Tailwind `rounded` (a 0.25rem literal) is
BANNED — `tailwindTheme.test.ts` enforces it; use `rounded-sm/md/lg`, which
resolve through these tokens.

**Acceptable hardcoded values** (do not tokenize):
- `0.5px` for retina sub-pixel borders
- `1px` or `2px` for borders, dividers, and inline elements (code spans, cursor indicators, focus underlines, scrollbar thumbs)
- `3px` for fine positioning offsets (e.g., `top: 3px` on a dot indicator)
- Focus indicator geometry (e.g., `0 0 4px 4px` for the U-shape underline)
- `@media print` blocks (color-mix() may not render in all print pipelines)
- Component-internal one-off dimensions — define a **local** CSS var on the component class instead of adding a global token. Example pattern from `universal-toolbar.css`:
  ```css
  .universal-toolbar {
    --universal-toolbar-height: 40px;
    height: var(--universal-toolbar-height);
  }
  ```

### Shadows

| Token | Value | Use For |
|-------|-------|---------|
| `--shadow-sm` | `0 1px 3px rgba(0,0,0,0.1)` | Hover tooltips, subtle elevation |
| `--shadow-md` | `0 2px 8px rgba(0,0,0,0.12)` | Inline popups |
| `--popup-shadow` | `0 4px 12px rgba(0,0,0,0.15)` | Standard popups, dialogs |
| `--popup-shadow-dark` | `0 4px 12px rgba(0,0,0,0.4)` | Dark mode popups |
| `--shadow-popup` | theme-adaptive (written by `applyTheme()`; static fallback aliases `--popup-shadow`) | Tailwind `shadow-popup` utility and typed-pathway consumers — adapts in dark themes without a `.dark-theme` rule |

### Popup Tokens

| Token | Value | Use For |
|-------|-------|---------|
| `--popup-padding` | `6px` | Standard popup padding |
| `--radius-lg` | `8px` | Popup border radius |

### Button/Icon Sizes

Use the icon size tokens for button dimensions:

| Token | Value | Use For |
|-------|-------|---------|
| `--icon-size-sm` | `24px` | Bar buttons, compact areas (`.vm-icon-btn--sm`) |
| `--icon-size-md` | `26px` | Popup action buttons |
| `--icon-size-lg` | `28px` | Toolbar buttons |

Icon SVG sizes (conventions, not tokens):

| Size | Value | Use For |
|------|-------|---------|
| Small icons | `14px` | Icon SVGs in popups |
| Standard icons | `18px` | Toolbar icon SVGs |

## Typography Tokens

| Token | Purpose | Static Default |
|-------|---------|----------------|
| `--font-ui` | CHROME text — the system face, never touched by settings (R3) | `system-ui, -apple-system, …` |
| `--font-sans` | READING text — the user's chosen document face; document selectors only | System fonts (runtime-written) |
| `--font-mono` | Code, URLs, paths — the user's mono face | `ui-monospace, monospace` (runtime-written) |
| `--editor-font-size` | Editor text size | `18px` |
| `--editor-font-size-mono` | Monospace text (85%) | `15.3px` |
| `--editor-line-height` | Line height ratio | `1.8` (runtime default; the `:root` static is 1.6 for print/SSR — see Note) |
| `--editor-line-height-px` | Absolute line height | `32.4px` (18px × 1.8; static 28.8px) |
| `--editor-block-spacing` | Spacing between blocks | `1em` |
| `--cjk-letter-spacing` | CJK character spacing | `0.05em` |
| `--editor-width` | Max editor content width | `50em` |

**Monospace stacks for character grids** (terminal, code blocks, Source mode): use `verifiedMonoStack()` from `src/services/fonts/`, never `resolveMonoFontStack()`. WebKitGTK under CJK locales does not skip absent families (#1334); the module header has the measurements.

**Note:** These tokens have static defaults in `:root` for print/SSR, but are dynamically updated by `useTheme.ts` based on user settings. For example, `--editor-line-height` defaults to `1.6` in CSS, but the user-facing default is `1.8` (set in `settingsStore.ts` as "Relaxed" and applied dynamically by `useTheme.ts`).

## Code/Syntax Tokens

| Token | Purpose | Light Default |
|-------|---------|---------------|
| `--code-bg-color` | Code block background | `#e5e4e4` |
| `--code-text-color` | Code text | `#1a1a1a` |
| `--code-border-color` | Code block border | `#d5d4d4` |
| `--code-line-height` | Code block line height | `1.45` |
| `--code-padding` | Code block horizontal padding | `18px` (dynamically set by `useTheme.ts` to base fontSize) |
| `--md-char-color` | Markdown syntax chars | `#777777` |
| `--meta-content-color` | Metadata content | `#777777` |

## Text Emphasis Tokens

| Token | Purpose | Default |
|-------|---------|---------|
| `--strong-color` | Bold text color | `rgb(63,86,99)` |
| `--emphasis-color` | Italic text color | `rgb(91,4,17)` |

## Layout Tokens

| Token | Purpose | Default |
|-------|---------|---------|
| `--sidebar-bg` | Sidebar background | `#e5e4e4` |
| `--workspace-rail-width` | Workspace rail column width | `30px` |
| `--bar-height` | Status bar / universal toolbar height | `40px` |
| `--shell-card-inset` | Gutter around the leading rail+sidebar card | `8px` |
| `--shell-card-radius` | Leading card radius, concentric with the 21px window corner | `13px` |
| `--shell-top-inset` | Top inset a full-height column leaves clear | `0px` |
| `--traffic-lights-zone` | Horizontal space the title bar keeps clear of the window controls | `0px` |
| `--traffic-lights-centre` | The window controls' optical line, which the title bar centres content on | `0px` |
| `--outline-width` | Outline panel width | `200px` |
| `--settings-nav-width` | Settings nav column width (read by Settings.tsx AND SettingsNav) | `13rem` |
| `--table-border-color` | Table borders | `#d5d4d4` |

**Shell chrome vars are written by `shellChromeVars()`** (`src/shell/shellChrome.ts`), not CSS. The `:root` values are fallbacks; change the TS constant. Consume `--shell-top-inset` (0 off macOS), never a literal. Traffic-light geometry derives from `TRAFFIC_LIGHT_POSITION` in `src/shell/trafficLights.ts`, declared in three places (`tauri.conf.json`, `window_manager/mod.rs`, `trafficLights.ts`) that `trafficLights.test.ts` keeps in sync; it needs the `macos-private-api` cargo feature.

## Browser Chrome Tokens

The browser frame is a true neutral — white in light themes, dark in dark ones — never theme-tinted.

| Token | Light | Dark (`.dark-theme`) |
|---|---|---|
| `--browser-bg-color` | `#ffffff` | `#23262b` |
| `--browser-bg-secondary` | `#f7f7f7` | `#2a2e34` |
| `--browser-bg-tertiary` | `#f1f3f4` | `#32363d` |
| `--browser-text-color` | `#202124` | `#d6d9de` |
| `--browser-text-secondary` | `#5f6368` | `#9aa0a6` |
| `--browser-text-tertiary` | `#80868b` | `#6b7078` |
| `--browser-border-color` | `#dadce0` | `#3a3f46` |
| `--browser-hover-bg` | `rgba(60,64,67,.08)` | `rgba(255,255,255,.08)` |
| `--browser-hover-bg-strong` | `rgba(60,64,67,.12)` | `rgba(255,255,255,.12)` |
| `--browser-accent-bg` | `#e8f0fe` | `rgba(88,166,255,.12)` |
| `--browser-accent-primary` | `#1a73e8` | `#58a6ff` |

Do not consume `--browser-*` directly: `shell/app-shell.css` shadows the global names onto them under `.browser-workspace-active`. The terminal (xterm canvas) follows via `theme/terminalThemeForBrowser.ts`; its test pins the neutral backgrounds equal to `white`/`night`.

## Focus Mode Tokens

| Token | Purpose | Default |
|-------|---------|---------|
| `--blur-text-color` | Blurred text color | `#c8c8c8` |
| `--blur-image-opacity` | Blurred image opacity | `0.5` |
| `--focus-dim-opacity` | Focus Mode dim level (useTheme.ts overrides) | `1` |
| `--source-mode-bg` | Source mode background | `rgba(0,0,0,0.02)` |

## Rules

1. **Never hardcode colors** - use tokens for all colors
2. **Check dark mode** - ensure token works in both themes
3. **Prefer semantic tokens** - use `--error-color` not `#cf222e`
4. **Use radius tokens** - prefer `--radius-sm/md/lg` over hardcoded px
5. **Use shadow tokens** - prefer `--shadow-sm/md`, `--popup-shadow` over hardcoded
6. **Update this doc** - when adding new tokens to index.css
7. **Frame ownership for nested containers** - When a wrapper exists (e.g., `.code-block-wrapper`), it owns background, border, and radius. Child elements (e.g., `pre`) should be transparent/flat.
8. **Scoped vars must be defined** - Don't use CSS vars that are only defined on sibling/unrelated selectors (e.g., using `--list-indent` inside blockquote when it's only defined on `ul/ol`).
9. **Scrollbars use tokens** - Scrollbar colors should use `--border-color` and `--md-char-color`, not hardcoded rgba.
10. **Dark alert tokens** - Use `--alert-*-dark` tokens in `.dark-theme` selectors with `color-mix()` for backgrounds.
11. **Use hover tokens** - Use `--hover-bg` and `--hover-bg-strong`, never `--bg-hover` or `--bg-active` (those don't exist).

## Two layers: semantic tokens above primitives

VMark's token system has **two layers**, both defined in `src/styles/index.css`:

1. **Semantic tokens** — named for their role (`--popup-padding`, `--icon-size-lg`, `--radius-sm`, `--spacing-2`, `--accent-bg`). **Always prefer these when one fits.**
2. **Primitives** — named for their value position on a scale (`--space-1-5: 6px`, `--font-size-sm: 12px`, `--duration-fast: 0.1s`, `--opacity-disabled: 0.4`, `--z-popup: 9999`). Reach for these **only when no semantic token covers the case**.

### Primitive scales

| Family | Tokens | Use when |
|---|---|---|
| Spacing (px) | `--space-px`, `--space-half` (2), `--space-1` (4), `--space-1-5` (6), `--space-2` (8), `--space-2-5` (10), `--space-3` (12), `--space-3-5` (14), `--space-4` (16), `--space-5` (20), `--space-6` (24), `--space-7` (28), `--space-8` (32), `--space-10` (40), `--space-15` (60) | A semantic spacing token (`--spacing-1/2/3`, `--popup-padding`) doesn't match the value |
| Border widths | `--border-hairline` (0.5px), `--border-thin` (1px), `--border-medium` (2px), `--border-thick` (4px) | Setting `border-width`, `border-{top,right,bottom,left}-width` |
| UI font sizes | `--font-size-xs` (11), `--font-size-sm` (12), `--font-size-base` (13), `--font-size-md` (14), `--font-size-lg` (16), `--font-size-xl` (22 — identity/display text, WI-UA13) | UI labels and metadata. **Not** for editor body text — that uses runtime `--editor-font-size*`. 10px (`--font-size-2xs`) was RETIRED outright by the 20260901 re-audit (WI-UB2) — the token, its `text-2xs` Tailwind bridge and all consumers are gone; UI text floors at `xs`. |
| Component dimensions | `--size-icon-xs` (14), `--size-icon-medium` (18), `--size-btn-xs` (20) | Width/height of small icons not covered by `--icon-size-*`. `--size-btn-sm` is gone — a 24px square is `.vm-icon-btn--sm`. |
| Line heights | `--line-height-tight` (1.25), `--line-height-snug` (1.35), `--line-height-base` (1.4), `--line-height-normal` (1.5), `--line-height-relaxed` (1.6) | `line-height` on UI text |
| Letter spacing | `--letter-spacing-tight` (0.3px), `--letter-spacing-loose` (0.5px), `--letter-spacing-caps` (0.5px) | `caps` is THE tracking for every `text-transform: uppercase` micro-label (WI-UA6, pinned by `uiAuditFixes.test.ts`); tight/loose serve non-caps uses |
| Opacity | `--opacity-disabled` (0.4), `--opacity-muted` (0.5), `--opacity-subtle` (0.6), `--opacity-half-faded` (0.7), `--opacity-mostly-opaque` (0.85) | Visual de-emphasis. **Not** for `0` or `1` — those stay literal. |
| Durations | `--duration-fast` (0.1s), `--duration-base` (0.15s), `--duration-medium` (0.2s), `--duration-slower` (0.6s), `--duration-1s`, `--duration-1-5s`, `--duration-5s` | `transition`, `animation` durations |
| Z-index | `--z-resize-handle` (10), `--z-panel-overlay` (12), `--z-bar` (100), `--z-toolbar` (102), `--z-toolbar-dropdown` (103), `--z-context-menu` (1000), `--z-mcp-overlay` (1200), `--z-popup` (9999), `--z-table-context` (10000) | Stacking context. Mirrors hierarchy in `32-component-patterns.md`. |

### What stays literal even with primitives

- **Animation keyframe percentages** (`0%`, `50%`, `100%`)
- **Transform scale/translate values** (`scale(0.78)` — optical adjustment, not a design knob)
- **`calc()` arithmetic with mixed units**
- **`var(--xyz, #fallback)` defensive fallbacks** (the fallback is intentionally a literal)
- **`rgba()` lines that precede `color-mix()` lines** (browser-fallback pattern)
- **CSS pseudo-element generated content** (`content: "✓"`)
- **`opacity: 0` / `opacity: 1`** (visibility flags, not design opacity)
- **`50%` for circles** (`border-radius: 50%`)
- **`100%` and `auto` keywords** (semantic CSS, not values)

## Tokenize value vs. tokenize intent

Pick a token by the CSS property's purpose, not by value coincidence (`4px` padding is not `--radius-sm`). Never run `/ui-tokenize:fix` here; treat `/ui-tokenize:audit` output as candidates only.

| CSS property | Use |
|---|---|
| `border-radius` | `--radius-*` |
| `padding`, `margin`, `gap` | `--spacing-*` (or `--popup-padding` in popups) |
| `width`/`height` of icon buttons | `--icon-size-*` |
| `top`/`left`/`right`/`bottom` | usually literal |

## Visual QA

After CSS changes, verify rendering with the reference document:

1. Open `dev-docs/css-reference.md` in VMark
2. Check both light and dark themes
3. Compare against baseline screenshots in `dev-docs/archive/screenshots/` (gitignored)

The reference document exercises all markdown elements: typography, lists, blockquotes, code blocks, tables, alerts, details, math, and footnotes.
