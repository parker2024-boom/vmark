/**
 * Source Cursor Tracker
 *
 * Purpose: publish the source editor's cursor snapshot and selected text to
 * the document store without doing the snapshot once per transaction. A held
 * arrow key or a burst of typing produces many CodeMirror updates per frame;
 * only the last cursor position of a frame is ever read, so only that one is
 * computed.
 *
 * Key decisions:
 *   - The snapshot is computed when the frame fires, from the view's state at
 *     that moment — not when the update arrived — so a frame costs one
 *     snapshot however many updates it saw.
 *   - Selected text is published immediately: the status bar reads it, and it
 *     costs only the selected ranges.
 *   - `flush()` publishes a pending snapshot now. The editor calls it before
 *     it hides or is destroyed, because the WYSIWYG editor restores its cursor
 *     from the stored snapshot and must not read one a frame out of date.
 *   - The tracker's extension also installs the fence index the snapshot reads
 *     (cursorSync/fenceIndex.ts), so the two cannot be wired apart.
 *
 * @coordinates-with SourceEditor.tsx — owns the tracker's lifetime
 * @coordinates-with utils/cursorSync/codemirror.ts — computes the snapshot
 * @coordinates-with utils/cursorSync/fenceIndex.ts — the field installed here
 * @module components/Editor/sourceCursorTracker
 */

import type { Extension } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { CursorInfo } from "@/types/cursorSync";
import { getCursorInfoFromCodeMirror } from "@/utils/cursorSync/codemirror";
import { sourceFenceIndex } from "@/utils/cursorSync/fenceIndex";

interface SourceCursorSinks {
  setCursorInfo: (info: CursorInfo) => void;
  setSelectedText: (text: string) => void;
}

export interface SourceCursorTracker {
  /** Record a selection or document change reported by CodeMirror. */
  track: (update: Pick<ViewUpdate, "state" | "view">) => void;
  /** Publish the pending cursor snapshot now, if there is one. Call before the view hides or is destroyed. */
  flush: () => void;
}

/** The state the cursor snapshot depends on; add it beside the update listener. */
export const sourceCursorExtension: Extension = sourceFenceIndex;

/** Create the tracker for one source editor view. */
export function createSourceCursorTracker(sinks: SourceCursorSinks): SourceCursorTracker {
  let pendingView: EditorView | null = null;
  let frame: number | null = null;

  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const view = pendingView;
    pendingView = null;
    if (view) sinks.setCursorInfo(getCursorInfoFromCodeMirror(view));
  };

  return {
    track(update) {
      // Aggregate every range — CodeMirror supports multi-range selection.
      const slices: string[] = [];
      for (const range of update.state.selection.ranges) {
        if (range.from !== range.to) slices.push(update.state.sliceDoc(range.from, range.to));
      }
      sinks.setSelectedText(slices.join("\n"));

      pendingView = update.view;
      if (frame === null) frame = requestAnimationFrame(flush);
    },
    flush,
  };
}
