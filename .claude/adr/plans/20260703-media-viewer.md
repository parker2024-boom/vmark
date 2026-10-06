# Decisions — Media Viewer — images / audio / video preview

> Plan: `dev-docs/plans/20260703-media-viewer.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the media viewer.
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-7. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1 — New `FormatKind: "media"` (not `"viewer"`)

`"viewer"` and `"split-pane"` both fall through to `SplitPaneEditor`, which
always mounts a CodeMirror `SourcePane` on the tab's text content. Binary
media has no text content. A dedicated `"media"` kind gets its own branch in
`Editor.tsx` and renders a full-width `MediaView` with no source pane.

### ADR-2 — Data path: Tauri asset protocol, not base64

`convertFileSrc(normalizePathForAsset(path))` → `asset://` URL loaded natively
by the webview. Native streaming: video/audio seekable, bytes never enter the
JS heap. `assetProtocol.scope` is already `["**/*"]` in `tauri.conf.json`.
base64/data-URL rejected: +33% size, whole file in the JS string heap (large
video → OOM), no seeking.

### ADR-3 — No UTF-8 read for binary

Branch in `openFileInNewTabCore` (`useFileOpen.ts`) after tab+format resolve,
before `readTextFile`: if `format.kind === "media"`, call
`initDocument(tabId, "", path)` and return. `content` stays empty — hot-exit
captures/restores from the empty snapshot content and never re-reads the file
(verified: `restoreHelpers.ts` restores from snapshot, not disk). Media tabs
are excluded from the external-file watcher's text re-read
(`useExternalFileChanges.ts`).

### ADR-4 — Broad list + graceful fallback ("as many as possible")

Register all common image/video/audio extensions (source of truth:
`src/utils/mediaExtensions.ts`, minus `svg` which owns its own format).
`MediaView` attempts native `<img>/<video>/<audio>`; on element `error`,
shows a fallback panel ("can't preview inline") with **Open with default
app** + **Reveal in Finder**. macOS WKWebView decodes HEIC / mov-h264 / FLAC
natively, so coverage is wide there; unsupported codecs degrade, never crash.

### ADR-5 — Shared render core for both surfaces

One `MediaView` component (path → resolved `asset://` → typed element +
fallback). The viewer tab wraps it; the Quick Look overlay wraps it. Pixel
parity, one place to fix.

### ADR-7 — MediaView owns the per-file asset grant

Live testing showed Quick Look (and arrow-nav) reach `MediaView` without going
through the tab-open path, so they never granted asset access → 403 → fallback.
Fix: `MediaView` grants `grant_asset_access` for its own path in an effect and
gates the media element on it. This makes EVERY entry point (tab, Quick Look,
arrow-nav, future embeds) serve real media, and it is the single source of the
grant (the open flow no longer grants). State is tracked per-path (not booleans)
so a path change resets granted/errored without a synchronous effect setState.
