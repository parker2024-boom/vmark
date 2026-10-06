/**
 * TiptapEditor module helpers
 *
 * Purpose: pure, editor-instance-level helpers extracted from TiptapEditor.tsx —
 * adaptive debounce sizing, the spellcheck size cutoff, the viewport-preserving
 * cv-idle toggle (#823, #1340) with the `.cv-enabled` sizing marker that
 * outlives it (#1472, #1473) and the platform gate that keeps both off macOS
 * (usesContentVisibility). No React state; safe to call from effects and
 * callbacks. Content loads live in `tiptapContentLoad.ts`.
 *
 * @coordinates-with utils/platform.ts — isMacPlatform for the content-visibility gate
 * @coordinates-with TiptapEditor.tsx — consumer; behavior documented there
 * @coordinates-with useContentVisibilityMode.ts — applies the cv classes outside edits
 * @module components/Editor/tiptapEditorHelpers
 */
import type { MutableRefObject } from "react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { EditorProps } from "@tiptap/pm/view";
import { getTiptapEditorView } from "@/services/editor/tiptapView";
import { handleTableScrollToSelection } from "@/plugins/tableScroll/scrollGuard";
import { setCvIdlePreservingViewport } from "./cvIdleViewportLock";
import { isMacPlatform } from "@/utils/platform";

/**
 * Delay before enabling cursor tracking after editor creation.
 * Prevents spurious cursor sync during initial render/focus.
 */
export const CURSOR_TRACKING_DELAY_MS = 200;

/**
 * Calculate adaptive debounce delay based on document size.
 * Larger documents get longer delays to reduce parsing overhead during typing.
 *
 * @param docSize - Document size in characters
 * @returns Delay in milliseconds
 */
export function getAdaptiveDebounceDelay(docSize: number): number {
  if (docSize > 1000000) return 5000; // 1M+: 5s (~1MB+ markdown)
  if (docSize > 500000) return 2000;  // 500K+: 2s
  if (docSize > 100000) return 1000;  // 100K+: 1s
  if (docSize > 50000) return 500;    // 50K+: 500ms
  if (docSize > 20000) return 300;    // 20K+: 300ms
  return 100;                          // Default: 100ms (using RAF for small docs)
}

/**
 * Mount-time editorProps for the WYSIWYG editor.
 *
 * The spellcheck attribute here is a snapshot of `docSize` at editor
 * creation; `applySpellcheckForDocSize` keeps it honest as the document
 * grows or shrinks across the threshold mid-session.
 */
export function buildTiptapEditorProps(docSize: number): EditorProps {
  return {
    attributes: {
      class: "ProseMirror",
      // Disable native browser spellcheck on large documents — over the
      // SPELLCHECK_DISABLE_CHAR_THRESHOLD the spellchecker holds the main
      // thread while rescanning after every edit, causing visible typing lag.
      spellcheck: spellcheckAttrForDocSize(docSize),
    },
    // Suppress ProseMirror's default scrollRectIntoView when cursor is in a
    // table to prevent horizontal scroll jumps on .table-scroll-wrapper
    handleScrollToSelection(view) {
      return handleTableScrollToSelection(view);
    },
  };
}

/**
 * Document-size threshold (in characters) above which native browser
 * spellcheck is disabled — on docs over 100K chars the spellchecker holds
 * the main thread while rescanning after every edit, causing visible typing
 * lag. Coincides with the adaptive-debounce 100K tier today, but the two
 * are independent knobs.
 */
export const SPELLCHECK_DISABLE_CHAR_THRESHOLD = 100_000;

/** Spellcheck DOM attribute value for a document of `docSize` characters. */
export function spellcheckAttrForDocSize(docSize: number): "true" | "false" {
  return docSize > SPELLCHECK_DISABLE_CHAR_THRESHOLD ? "false" : "true";
}

/**
 * Re-apply the spellcheck cutoff on a live editor. The mount-time
 * `editorProps.attributes.spellcheck` value is computed once and never
 * re-evaluated, so a document that grows past the threshold mid-session
 * would keep native spellcheck (and its per-edit full rescans) forever.
 *
 * Rebuilds the full editorProps via {@link buildTiptapEditorProps} — the
 * single source of truth for the WYSIWYG editor's props — so declarative
 * state and the DOM can never disagree about anything but the doc size.
 * Returns true when a change was applied.
 */
export function applySpellcheckForDocSize(
  editor: TiptapEditor,
  docSize: number,
): boolean {
  if (editor.isDestroyed) return false;
  const view = getTiptapEditorView(editor);
  // view.dom can be absent on partially-constructed (or test-mocked) views.
  if (!view?.dom) return false;
  const desired = spellcheckAttrForDocSize(docSize);
  // No-op check reads the declarative options (the source of truth the DOM
  // is derived from), not the DOM attribute itself.
  const currentAttributes = editor.options.editorProps?.attributes;
  const currentSpellcheck =
    typeof currentAttributes === "object" && currentAttributes !== null
      ? (currentAttributes as Record<string, string>).spellcheck
      : undefined;
  if (currentSpellcheck === desired) return false;

  editor.setOptions({ editorProps: buildTiptapEditorProps(docSize) });
  return true;
}

/**
 * Document-size threshold (in characters) above which content-visibility
 * optimization is enabled. Below this, the cv-idle toggle causes visible
 * layout shift on every keystroke-to-idle transition because `auto`
 * intrinsic-size estimates diverge from real block heights when off-screen
 * blocks have never been rendered. For small docs the optimization delivers
 * no measurable win and the toggle produces a "shaking" / rippling effect
 * as the total document height changes on each idle interval (#823).
 *
 * Large documents keep the toggle and pay the same estimate-vs-real
 * divergence — which used to throw the viewport (and the user's selection)
 * out of view on every edit (#1340). Both toggle directions are now
 * scroll-compensated; see {@link suppressCvIdleDuringEdit}.
 */
export const CV_IDLE_CHAR_THRESHOLD = 50_000;

/**
 * Whether a document of `docSize` characters gets the content-visibility
 * optimization at all: large enough (see {@link CV_IDLE_CHAR_THRESHOLD}) and
 * NOT on macOS.
 *
 * In the macOS app (WKWebView) `content-visibility: auto` on every top-level
 * block is the opposite of an optimization. Measured on a 420K-character
 * document with 4,042 blocks (2540×1295 window at 2x): every scrolled frame
 * cost ~1.2 s with it and ~20 ms without, and a static, script-free clone of
 * the same DOM measured the same 1.2 s — the cost is the engine's layout, not
 * the editor. Without it WebKit lays the whole document out once (~1 s at
 * open) and scrolls from then on. Windows (WebView2) and Linux (WebKitGTK)
 * were not measured and keep the optimization.
 */
export function usesContentVisibility(docSize: number): boolean {
  return docSize >= CV_IDLE_CHAR_THRESHOLD && !isMacPlatform();
}

/**
 * Marks an editor that uses content-visibility, for as long as it does. editor.css
 * scopes `contain-intrinsic-size: auto` to it: remembered sizes survive the strip of
 * `.cv-idle` (#1472), and editors that never skip a block record none (#1473).
 */
export const CV_ENABLED_CLASS = "cv-enabled";

/** Mount: both classes at once — no block has been laid out, so no size to wait for. */
export function applyContentVisibilityAtMount(container: HTMLElement, enabled: boolean): void {
  container.classList.toggle(CV_ENABLED_CLASS, enabled);
  container.classList.toggle("cv-idle", enabled);
}

/**
 * Bring the classes to rest for `enabled` outside an edit (a document load, an
 * editor shown again): an edit's transition across the threshold, or a fresh
 * idle window when the marker is on but `.cv-idle` is neither applied nor due.
 */
export function followContentVisibility(
  containerRef: MutableRefObject<HTMLDivElement | null>,
  enabled: boolean,
  cvIdleTimeoutRef: MutableRefObject<number | null>,
): void {
  const container = containerRef.current;
  if (!container) return;
  const idleOrDue = container.classList.contains("cv-idle") || cvIdleTimeoutRef.current !== null;
  const atRest = container.classList.contains(CV_ENABLED_CLASS) === enabled && (!enabled || idleOrDue);
  if (!atRest) setContentVisibility(containerRef, enabled, cvIdleTimeoutRef);
}

/**
 * Suppress content-visibility during active typing — keeping cv on during
 * edits costs O(blocks-after-insertion)/keystroke (378ms on a 2250-block
 * doc). Re-enables after 500ms idle and a rendered frame so scroll/repaint keep the optimization.
 *
 * Documents that do not get the optimization at all ({@link usesContentVisibility})
 * skip the re-enable entirely: every document on macOS, and small ones
 * (<CV_IDLE_CHAR_THRESHOLD) everywhere — for those the toggle causes visible
 * shaking, as `contain-intrinsic-size: auto` fallbacks don't match real block
 * heights when off-screen blocks have never been rendered, and small docs
 * don't need the optimization anyway (#823).
 *
 * The same decision sets `.cv-enabled`: an edit that grows the document past the
 * threshold marks it at once, and `.cv-idle` follows after the idle window with
 * every block's size on record; one that shrinks it below drops both, and the re-add.
 *
 * Both class toggles go through {@link setCvIdlePreservingViewport}: on a
 * large doc the same estimate-vs-real height divergence changes the height of
 * content ABOVE the viewport, so an unadjusted scrollTop threw the selection
 * out of view on every edit — including toolbar mark toggles (#1340). The
 * strip only measures when the class is actually present; within the idle
 * window (the per-keystroke hot path) it is already off and nothing is
 * measured or written.
 *
 * Hiding the editor (Source mode toggled within the window) cancels the re-add
 * and showing it starts a fresh window (useContentVisibilityMode); a timer
 * that still fires on a display:none container re-adds class-only, with no
 * anchor to measure. Unmount never reaches the timer: useTiptapUnmountFlush clears it.
 */
export function suppressCvIdleDuringEdit(
  containerRef: MutableRefObject<HTMLDivElement | null>,
  docSize: number,
  cvIdleTimeoutRef: MutableRefObject<number | null>,
): void {
  setContentVisibility(containerRef, usesContentVisibility(docSize), cvIdleTimeoutRef);
}

/**
 * Strip `.cv-idle`; when `enabled`, bring it back after 500ms idle and a rendered frame. The marker goes on before
 * the strip and off after it, so the rule never lapses while the optimization is on and a
 * re-add is pending only while it is set. A forced toggle writes nothing if the class matches.
 */
function setContentVisibility(
  containerRef: MutableRefObject<HTMLDivElement | null>,
  enabled: boolean,
  cvIdleTimeoutRef: MutableRefObject<number | null>,
): void {
  const container = containerRef.current;
  if (!container) return;
  if (enabled) container.classList.toggle(CV_ENABLED_CLASS, true);
  if (container.classList.contains("cv-idle")) {
    setCvIdlePreservingViewport(container, false);
  }
  if (!enabled) container.classList.toggle(CV_ENABLED_CLASS, false);
  if (cvIdleTimeoutRef.current !== null) {
    window.clearTimeout(cvIdleTimeoutRef.current);
    cvIdleTimeoutRef.current = null;
  }
  if (enabled) {
    const id = window.setTimeout(() => reAddAfterARenderedFrame(containerRef, cvIdleTimeoutRef, id), 500);
    cvIdleTimeoutRef.current = id;
  }
}

/**
 * The idle window's end: re-add `.cv-idle` once a frame has rendered.
 * `contain-intrinsic-size: auto` remembers a block's size only when a frame
 * renders it, and the timer can fire before any has — straight after a long
 * load task. Skipping then collapses every block to the estimate (a measured
 * 20,000 px jump on a large document in Linux WebKit). The second callback runs
 * after the first one's frame has rendered. The ref stays set through the wait,
 * so the re-add is still "due"; any cancel or new window replaces it, and a
 * callback that no longer owns the ref does nothing.
 */
function reAddAfterARenderedFrame(
  containerRef: MutableRefObject<HTMLDivElement | null>,
  cvIdleTimeoutRef: MutableRefObject<number | null>,
  id: number,
): void {
  const owns = () => cvIdleTimeoutRef.current === id;
  window.requestAnimationFrame(() => {
    if (!owns()) return;
    window.requestAnimationFrame(() => {
      if (!owns()) return;
      cvIdleTimeoutRef.current = null;
      const idleContainer = containerRef.current;
      if (idleContainer) setCvIdlePreservingViewport(idleContainer, true);
    });
  });
}
