# Decisions — Terminal — Road to Industrial-Best (Implementation Plan)

> Plan: `dev-docs/plans/20260531-terminal-industrial-best.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the terminal (`src-tauri/src/pty.rs`, `src/lib/pty.ts`, shell integration).
> Defines: ADR-T1, ADR-T2, ADR-T3, ADR-T4. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-T1 — PTY output transport is a binary Tauri `Channel<&[u8]>`

**Status:** Proposed (spike-gated by WI-0.2).
**Context.** Output is emitted as `app.emit("pty:data:{pid}", Vec<u8>)`
(`pty.rs:265`), which Tauri serializes as a JSON array of numbers and broadcasts
to every webview (audit T1/T2). This is the throughput ceiling.
**Decision.** Replace the output event with a per-session
`tauri::ipc::Channel<&[u8]>` passed into `pty_start`. The channel is
point-to-point (fixes T2 for free) and transfers an `ArrayBuffer`
(`term.write(Uint8Array)` consumes it directly, no JSON round-trip).
**Consequences.** New IPC pattern (no `Channel` precedent in-repo). The
`pty:exit` signal stays an event (low frequency, simple payload). Flow-control
likely simplifies (see WI-1.4). Spike WI-0.2 must confirm binary delivery and a
measurable win over the JSON path before Phase 1 commits.

### ADR-T2 — cwd source of truth is OSC 7

**Status:** Proposed.
**Context.** cwd is resolved once at spawn (`spawnPty.ts:58`) and never updated;
relative file links resolve against workspace root, not the shell's location
(audit C2/M2).
**Decision.** Register `term.parser.registerOscHandler(7, ...)`, parse
`file://host/path`, and store live cwd on the session entry. Shell-integration
rc-hooks (ADR-T3) emit OSC 7 on every prompt. "New terminal here", relative-link
resolution, and workspace-`cd` skipping read this value.
**Consequences.** cwd is only as fresh as the last prompt (acceptable —
matches every other terminal). Falls back to workspace root when OSC 7 is absent
(integration disabled or unsupported shell).

### ADR-T3 — Shell integration via non-destructive injected rc-hooks, opt-in

**Status:** Proposed (spike-gated by WI-0.3).
**Context.** No command-boundary awareness (audit M1). The standard mechanism is
injecting `precmd`/`preexec` hooks that emit OSC 133 A/B/C/D + OSC 7.
**Decision.** Ship per-shell integration scripts as Tauri resources and inject
them **without clobbering the user's config**, using each shell's supported hook:
- **zsh:** set `ZDOTDIR` to a temp dir whose `.zshrc` sources the user's real
  `$ZDOTDIR/.zshrc` then appends our hooks.
- **bash:** `--rcfile` pointing at a wrapper that sources the user's `~/.bashrc`
  then appends our hooks.
- **fish:** prepend our snippet via `XDG_DATA_DIRS` / a conf.d entry.
Gate behind a `terminal.shellIntegration` setting (default **on** for zsh/bash/
fish, **off**/no-op for unknown shells). Always degrade gracefully — a failed
injection must never break shell startup.
**Consequences.** Per-shell complexity; macOS-primary (zsh first, then bash, then
fish). WI-0.3 validates the zsh path end-to-end before Phase 3 commits. If the
spike fails for a shell, that shell falls back to no-integration (features hide,
terminal still works).

### ADR-T4 — Scrollback persistence is serialize-on-hide, opt-in; else remove the addon

**Status:** Proposed.
**Context.** `SerializeAddon` is loaded per instance (`createTerminalInstance.ts:157`)
but **never called** — dead weight (audit C3). `uiStore` has no `persist`
middleware, so no terminal state survives restart.
**Decision.** Two independent calls:
1. Persist the lightweight `terminal` slice (session list, active id, panel
   size) via Zustand `persist` (WI-5.1).
2. For scrollback: if WI-0.1's baseline shows acceptable serialize cost, write
   `serializeAddon.serialize()` on hide/quit and replay on restore (WI-5.2);
   otherwise **delete the addon** rather than ship it unused.
**Consequences.** Restart restores tabs/layout cheaply; scrollback restore is a
measured opt-in, not an assumption.
