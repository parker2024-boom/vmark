---
paths:
  - "src/**"
  - "src-tauri/src/**"
  - "website/**"
---

# 21 - Website Documentation Sync

When making changes that affect user-facing behavior, update the corresponding website documentation.

## Trigger Conditions

Update website docs when:

| Change Type | Website File to Update |
|-------------|------------------------|
| Add/modify keyboard shortcuts | `website/guide/shortcuts.md` |
| Add/modify features | `website/guide/features.md` |
| Change popup behavior | `website/guide/popups.md` |
| Change multi-cursor behavior | `website/guide/multi-cursor.md` |
| Add/modify MCP tools | `website/guide/mcp-tools.md` |
| Change MCP setup process | `website/guide/mcp-setup.md` |
| Add/modify Mermaid support | `website/guide/mermaid.md` |
| Change CJK formatting | `website/guide/cjk-formatting.md` |
| Change tab/window behavior | `website/guide/tab-navigation.md` |
| Change export/print behavior | `website/guide/export.md` |
| Change AI provider setup | `website/guide/ai-providers.md` |
| Change AI Genies feature | `website/guide/ai-genies.md` |
| Change terminal feature | `website/guide/terminal.md` |
| Change embedded browser behavior (surface, delegates, chrome, entry point) | `website/guide/browser.md` |
| Change SVG handling | `website/guide/svg.md` |
| Change Markmap support | `website/guide/markmap.md` |
| Add/modify markdown lint rules | `website/guide/lint.md` |
| Change broken-link checking | `website/guide/link-check.md` |
| Change PTY / terminal pause | `website/guide/terminal.md` |
| Change workspace content search | `website/guide/workspace-management.md` |
| Change workspace rail behavior (rail UI, context switch, per-workspace terminal scoping) | `website/guide/workspace-rail.md` |
| Add/modify AI suggestion UI | `website/guide/ai-genies.md` |
| Add/modify format adapter (registry / dispatch / new file type) | `website/guide/formats.md` |
| Change SplitPaneEditor behavior (source pane, validation gutter, split UX) | `website/guide/formats.md` |
| Change `formats.*` settings (toggles, externalEditor, upgrade nudge) | `website/guide/settings.md` (`Formats` section) + `website/guide/formats.md` |
| Change `open_in_external_editor` Tauri command | `website/guide/formats.md` (`Open in external editor`) |
| Change the Source-mode media preview (triggers, media types) | `website/guide/popups.md` (Media Popup → Source Mode) |
| Change an action's mode support (e.g. Source-only line sorting) | `website/guide/shortcuts.md` (F-Key Quick Reference + the action's section) |
| Change the markdown dialect, a remark plugin, or the nesting limit | `website/guide/formats.md` (`Markdown dialect`) + `website/guide/large-files.md` |
| Change OS file associations or the Windows installer hooks | `website/guide/formats.md` (`Opening files from your system`) |
| Change the external-editor override validation | `website/guide/formats.md` (`Security gate`) + `website/guide/settings.md` (`External editor`) |
| Change workflow conditions, cancel, or run gating | `website/guide/workflows.md` (`Conditions`, `Running a workflow`, `Execution flow` diagram) |
| Change a status-bar indicator | `website/guide/features.md` (`Status Bar`) |
| Change IME handling, reduced motion, the inactive-selection overlay or the inline-code boundary | `website/guide/features.md` (`Editing Details`) |
| Change the monospace-font verification | `website/guide/features.md` (`Fonts`) |
| Change the tab context menu, pinning, or tab / title-bar rename | `website/guide/tab-navigation.md` (`The tab context menu`, `Pinned tabs`, `Renaming a file`) |
| Change save-on-close prompts, quit confirmation, or the pinned-tabs close guard | `website/guide/tab-navigation.md` (`Closing tabs and windows`) |
| Change the browser start page, search engine, or omnibox rules | `website/guide/browser.md` (`Using it`) |
| Change prompt history | `website/guide/ai-genies.md` (`The Genie Picker`) |
| Change the per-client MCP credential (`VMARK_MCP_TOKEN`) or what it authorizes | `website/guide/mcp-setup.md` (`Install Configuration`, `Security Notes`) |
| Change how the Claims panel is opened | `website/guide/coherence.md` |
| Change an MCP action's arguments, results or refusal reasons | `website/guide/mcp-tools.md` + `server/mcp/README.md` |
| Change how a terminal session is ended, or which shells may be spawned | `website/guide/terminal.md` (`Sessions`, `Shell Environment`) + `website/guide/settings.md` (Terminal → Shell) |
| Change the SVG sanitizer (stylesheets, forms, links) | `website/guide/svg.md` (`Security`) |
| Change when or where the E2E journeys run in CI | `e2e/README.md` (`Prerequisites`, `CI`) |
| Add new release post / launch note | `website/blog/<YYYY-MM>-<slug>.md` + entry in `website/blog/index.md` |
| New major feature | Consider adding new guide page |

## File Mapping

| Source Code Area | Website Page |
|------------------|--------------|
| `src/stores/settingsStore/shortcuts.ts` | `website/guide/shortcuts.md` |
| `src-tauri/src/menu/` | `website/guide/shortcuts.md` |
| `src-tauri/src/mcp_bridge/`, `mcp_config/` | `website/guide/mcp-tools.md` |
| Popup components | `website/guide/popups.md` |
| Multi-cursor hooks | `website/guide/multi-cursor.md` |
| `src/components/Tabs/`, `src/services/tabs/` | `website/guide/tab-navigation.md` |
| `src/components/TitleBar/useTitleBarRename.ts` | `website/guide/tab-navigation.md` (Renaming a file) |
| `src/services/windowClose/`, `src-tauri/src/quit.rs` | `website/guide/tab-navigation.md` (Closing tabs and windows) |
| `src/export/` | `website/guide/export.md` |
| `src-tauri/src/ai_provider/` | `website/guide/ai-providers.md` |
| `src/components/GeniePicker/` | `website/guide/ai-genies.md` |
| `src/components/Terminal/`, `src-tauri/src/pty.rs` | `website/guide/terminal.md` |
| `src/components/Browser/`, `src-tauri/src/browser/`, `src/services/commands/browserCommands.ts` | `website/guide/browser.md` |
| `src/plugins/mermaid*/` | `website/guide/mermaid.md` |
| `src/lib/cjkFormatter/`, `src/plugins/toolbarActions/*Cjk*` | `website/guide/cjk-formatting.md` |
| `src/lib/lintEngine/`, `src/plugins/lint/` | `website/guide/lint.md` |
| `src/lib/markdownLinkCheck/` | `website/guide/link-check.md` |
| `src-tauri/src/content_search.rs` | `website/guide/workspace-management.md` (Workspace Content Search) |
| `src/components/WorkspaceRail/`, `src/services/workspaces/` (instances, switch, close/move) | `website/guide/workspace-rail.md` |
| `src/plugins/aiSuggestion/`, `src/stores/aiStore/suggestion.ts` | `website/guide/ai-genies.md` (AI Suggestions section) |
| `src/lib/formats/` (registry + adapters) | `website/guide/formats.md` |
| `src/components/Editor/SplitPaneEditor/` | `website/guide/formats.md` |
| `src/pages/settings/FormatsSettings.tsx` | `website/guide/settings.md` (Formats section) |
| `src-tauri/src/external_editor.rs` | `website/guide/formats.md` (Open in external editor) |
| `src/hooks/useFormatsUpgradeNudge.ts` | `website/guide/settings.md` (Formats — One-time upgrade nudge) |
| `src/plugins/codemirror/sourceImagePreview.ts` | `website/guide/popups.md` (Media Popup → Source Mode) |
| `src/utils/markdownPipeline/` (dialect, `nestingDepth.ts`) | `website/guide/formats.md` (Markdown dialect) |
| `src-tauri/tauri.conf.json` (`fileAssociations`), `src-tauri/windows/installer-hooks.nsh` | `website/guide/formats.md` (Opening files from your system) |
| `src-tauri/src/external_editor/` | `website/guide/formats.md` (Security gate) + `website/guide/settings.md` (External editor) |
| `src-tauri/src/workflow/` (`condition*.rs`, `step_preflight.rs`, `state.rs`), `src/components/Editor/WorkflowPanel/` | `website/guide/workflows.md` |
| `src/components/StatusBar/` | `website/guide/features.md` (Status Bar) |
| `src/plugins/compositionGuard/`, `src/utils/imeGuard.ts`, `src/services/ime/`, `src/utils/motion.ts`, `src/plugins/inactiveSelection/`, `src/plugins/inlineCodeBoundary/` | `website/guide/features.md` (Editing Details) |
| `src/services/fonts/verifiedMonoStack.ts` | `website/guide/features.md` (Fonts) |
| `src/lib/browser/omnibox.ts` | `website/guide/browser.md` (Using it) |
| `src/stores/aiStore/promptHistory.ts`, `src/components/GeniePicker/PromptHistoryDropdown.tsx` | `website/guide/ai-genies.md` (The Genie Picker) |
| `src-tauri/src/mcp_config/client_tokens.rs`, `src-tauri/src/mcp_config/client_token_field.rs`, `src-tauri/src/mcp_bridge/principal.rs` | `website/guide/mcp-setup.md` (Install Configuration, Security Notes) |
| `src/services/commands/claimCommands.ts` | `website/guide/coherence.md` |
| `src/services/mcpBridge/v2/`, `server/mcp/src/tools/` | `website/guide/mcp-tools.md` + `server/mcp/README.md` |
| `src-tauri/src/pty/child.rs`, `src-tauri/src/pty/spawn_policy.rs`, `src-tauri/src/shell_env.rs` | `website/guide/terminal.md` (Sessions, Shell Environment) |
| `src/utils/svgSanitize.ts`, `src/utils/svgStylesheetScope.ts` | `website/guide/svg.md` (Security) |
| `.github/workflows/tier0-e2e.yml`, `e2e/run-journeys.mjs` | `e2e/README.md` |
| `src/pages/settings/components.tsx` (SearchInput / FieldInput primitives) | No website doc — internal API. Keep `components.tsx` header comment as the source of truth for the decision rule. |

## Timestamp Handling

- Website uses **git-based lastUpdated** (configured in `.vitepress/config.ts`)
- Timestamps update automatically when files are committed
- No manual timestamp updates needed

## Update Process

1. Make the code change
2. Identify affected website page(s) from the mapping above
3. Update the relevant `.md` file in `website/guide/`
4. Carry the change into every `website/<locale>/guide/` page (the `translate-docs` skill). `pnpm lint:doc-joins` fails when a locale page's headings, tables, code blocks, Mermaid diagrams or `:::` containers stop matching English (`locale-structure`), and when a guide sentence that states a constant, a name or a list stops matching the code (`guide-claims`, table in `scripts/lib/docJoins/guideClaimsTable.mjs` — add a claim there when you write a new checkable one)
5. Commit code and docs together (or in the same PR)

## Verification

After updating website docs:
```bash
cd website && pnpm build
```

Check the built page shows correct content and updated timestamp.
