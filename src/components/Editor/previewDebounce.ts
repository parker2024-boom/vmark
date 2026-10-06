/**
 * Preview Debounce
 *
 * Purpose: decide how long a split-view preview waits before it re-parses the
 * document being typed in the source pane. Re-parsing is a pass over the whole
 * document; doing it on every keystroke of a large one is what makes typing in
 * split view lag.
 *
 * Key decisions:
 *   - The wait is the WYSIWYG flush's size tier (`getAdaptiveDebounceDelay`),
 *     not a second table: the two answer the same question — how often can a
 *     document of this size afford a full pass — in opposite directions.
 *   - A small document is not delayed at all. The WYSIWYG flush gives its
 *     smallest tier one animation frame; a preview gets the same by rendering
 *     as React schedules it.
 *   - Trailing only: the preview shows the last settled content until typing
 *     pauses for the tier's delay, then catches up once.
 *
 * @coordinates-with tiptapEditorHelpers.ts — owns the size tiers
 * @coordinates-with useTiptapContentSync.ts — the markdown split's preview pane
 * @coordinates-with SplitPaneEditor/usePreviewModel.ts — every other format's preview
 * @module components/Editor/previewDebounce
 */

import { useEffect, useState } from "react";
import { getAdaptiveDebounceDelay } from "./tiptapEditorHelpers";

/** The tier the WYSIWYG flush serves with an animation frame instead of a timer. */
const IMMEDIATE_TIER_MS = 100;

/**
 * Milliseconds a preview waits after the last change before re-parsing a
 * document of `docSize` characters; 0 means re-parse at once.
 */
export function previewSyncDelay(docSize: number): number {
  const delay = getAdaptiveDebounceDelay(docSize);
  return delay <= IMMEDIATE_TIER_MS ? 0 : delay;
}

/**
 * `content`, held back while a large document is being typed: returns the
 * last settled content until `content` has stopped changing for
 * `previewSyncDelay`. A small document passes straight through.
 */
export function useSettledPreviewContent(content: string): string {
  const [settled, setSettled] = useState(content);
  const delay = previewSyncDelay(content.length);

  // Adjusting state during render: with no delay the settled value IS the
  // content, and keeping it so means a document that later grows past the
  // threshold holds its latest content rather than an old one.
  if (delay === 0 && settled !== content) setSettled(content);

  useEffect(() => {
    if (delay === 0 || content === settled) return;
    const timer = window.setTimeout(() => setSettled(content), delay);
    return () => window.clearTimeout(timer);
  }, [content, delay, settled]);

  return delay === 0 ? content : settled;
}
