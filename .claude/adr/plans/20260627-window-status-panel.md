# Decisions — Window Status Panel (#1057)

> Plan: `dev-docs/plans/20260627-window-status-panel.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the window status panel (`src-tauri/src/window_status/`).
> Defines: ADR-1, ADR-2, ADR-3. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

- **ADR-1 — Status sources are the two *reliable* signals only.** (a) VMark's
  AI-genie invocation state (`useAiInvocationStore`: running / error / idle +
  elapsed) and (b) the terminal **bell** (`onBell` → a discrete BEL event; Claude
  Code rings it on turn-end / awaiting-input). We do NOT parse PTY output for a
  run-state (fragile; that's ClauDepot's external job). "Attention" = a bell rang
  while the window was unfocused; cleared when the window is focused.

- **ADR-2 — Rust app-state is the cross-window registry.** Windows are isolated;
  each reports its status via `invoke`, Rust keeps `HashMap<label, WindowStatus>`
  and broadcasts `window-status:changed` (global `app.emit`) so any window's panel
  renders the full set. Registry entry is removed on `WindowEvent::Destroyed`.

- **ADR-3 — Reuse existing seams.** Bell already flows through
  `useTerminalSessions` `onBell` + `terminalAttention.ts`; AI state already lives
  in `useAiInvocationStore`; window focus already exists (`set_focus`). The panel
  follows the `KnowledgeBaseOverlay` docked-panel pattern; the Window-menu toggle
  follows the `knowledge-base` command-bus pattern.
