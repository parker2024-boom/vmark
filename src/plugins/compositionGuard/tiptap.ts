/**
 * Composition Guard Tiptap Extension
 *
 * Purpose: Protects IME (Input Method Editor) composition from interference by other
 * plugins, and fixes Safari-specific composition bugs in table header cells.
 *
 * Key decisions:
 *   - High priority (1200) to intercept events before other plugins process them
 *   - Tracks composition state (anchor, data) to correctly handle composition end
 *   - Where the composition began is an ANCHOR that follows the document, not a
 *     number read once. filterTransaction has to admit document changes during
 *     composition (below), so text can move under a raw position; the cleanup
 *     then deleted the user's own words in front of the composed text. Every
 *     applied transaction is handed to the anchor, and every reader asks it for
 *     the position in the document it is looking at — see compositionAnchor.ts
 *   - The plugin state field stores nothing. It exists for `apply`, the one
 *     hook ProseMirror calls with each transaction that is actually applied
 *   - The anchor is forgotten once the post-composition frame has run, so
 *     nothing keeps acting on a composition that is over
 *   - filterTransaction allows doc-changing transactions during composition because
 *     ProseMirror may omit "composition" meta when storedMarks are present (#66)
 *   - Safari fix: ProseMirror's fixUpBadSafariComposition displaces cursor in table headers;
 *     this plugin uses appendTransaction to restore correct cursor position
 *   - Split-block fix: macOS WebKit can split headings during IME composition acceptance;
 *     appendTransaction detects the structural split (heading gains a new paragraph sibling),
 *     and the rAF cleanup repairs it once the composed text has been inserted
 *   - Grace period after compositionend prevents race conditions with queued actions
 *   - Flushes queued ProseMirror actions after composition ends
 *
 * Known limitations:
 *   - Safari table header fix uses heuristic position detection, may not cover all edge cases
 *   - A document write that arrives mid-composition is survived, not prevented:
 *     the anchor moves or retires, but the browser's composition may still be
 *     disturbed by the redraw. Writers should hold back until it has ended
 *
 * @coordinates-with utils/imeGuard.ts — IME state tracking and action queuing utilities
 * @coordinates-with plugins/compositionGuard/compositionAnchor.ts — where the composition began
 * @coordinates-with plugins/compositionGuard/imeCleanup.ts — the post-composition repair
 * @coordinates-with plugins/compositionGuard/splitBlockFix.ts — split-block repair for headings
 * @module plugins/compositionGuard/tiptap
 */

import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import {
  flushProseMirrorCompositionQueue,
  HANGUL_RE,
  IME_GRACE_PERIOD_MS,
  isProseMirrorInCompositionGrace,
  markProseMirrorCompositionEnd,
} from "@/utils/imeGuard";
import { splitBlock } from "@tiptap/pm/commands";
import { fixCompositionSplitBlock } from "./splitBlockFix";
import { shouldGuardKeyEvent } from "./compositionKeys";
import { createCompositionAnchor } from "./compositionAnchor";
import { cleanUpAfterComposition, findTableCellDepth } from "./imeCleanup";

/** Tiptap extension that guards against IME composition artifacts in ProseMirror. */
export const compositionGuardExtension = Extension.create({
  name: "compositionGuard",
  priority: 1200,
  addProseMirrorPlugins() {
    let isComposing = false;
    const anchor = createCompositionAnchor();
    let compositionData = "";
    let compositionPinyin = "";

    // Korean Hangul: Enter during composition confirms the syllable AND
    // requests a newline. Our handleKeyDown blocks Enter to prevent premature
    // block splitting, but that also swallows the newline intent. This flag
    // queues a deferred splitBlock after the grace period (Tiptap #4108).
    let pendingEnterAfterComposition = false;
    let pendingEnterTimer: ReturnType<typeof setTimeout> | null = null;

    // Set to true by appendTransaction when it detects a heading→paragraph
    // split during composition. The rAF cleanup checks this flag to know
    // it should attempt the split-block fix (by which time the browser has
    // inserted the composed text into the paragraph).
    let splitDetected = false;

    // Set after compositionend in a tableHeader cell.
    // appendTransaction consumes this to fix cursor position after
    // ProseMirror's fixUpBadSafariComposition displaces it.
    let pendingHeaderCursorFix: { data: string } | null = null;

    return [
      new Plugin({
        state: {
          init: () => null,
          apply(tr) {
            anchor.follow(tr);
            return null;
          },
        },
        appendTransaction(_transactions, _oldState, newState) {
          // 1. Split-block detection: during/after composition, watch for the
          //    heading being split into heading + paragraph. The browser does
          //    this ~4ms BEFORE compositionend fires, so we can't fix it here
          //    (the composed text isn't in the paragraph yet). We flag it so
          //    the rAF cleanup knows to attempt the fix.
          const startPos = anchor.at(newState.doc);
          if (startPos !== null &&
              !splitDetected &&
              _transactions.some((tr) => tr.docChanged)) {
            try {
              const $start = newState.doc.resolve(startPos);
              if ($start.parent.type.name === "heading" &&
                  _oldState.doc.childCount < newState.doc.childCount) {
                splitDetected = true;
              }
            } catch { /* stale pos */ }
          }

          // 2. Table header cursor fix (Safari-specific).
          if (!pendingHeaderCursorFix) return null;

          const { data } = pendingHeaderCursorFix;

          // Only consume on doc-changing transactions (the composition flush)
          if (!_transactions.some((tr) => tr.docChanged)) return null;
          pendingHeaderCursorFix = null;

          try {
            const { from } = newState.selection;
            const $from = newState.doc.resolve(from);

            // Only fix when cursor is at start of paragraph inside tableHeader
            if ($from.parentOffset !== 0) return null;
            if ($from.parent.type.name !== "paragraph") return null;

            let inTableHeader = false;
            for (let d = $from.depth; d > 0; d -= 1) {
              if ($from.node(d).type.name === "tableHeader") {
                inTableHeader = true;
                break;
              }
            }
            if (!inTableHeader) return null;

            // Verify text starts with composed data
            if (!$from.parent.textContent.startsWith(data)) return null;

            // Move cursor to after composed text
            const correctPos = Math.min(from + data.length, newState.doc.content.size);
            return newState.tr.setSelection(TextSelection.create(newState.doc, correctPos));
          } catch {
            return null;
          }
        },
        filterTransaction(tr) {
          if (!isComposing) return true;

          const compositionMeta = tr.getMeta("composition");
          const uiEvent = tr.getMeta("uiEvent");

          if (compositionMeta) return true;
          if (uiEvent === "input" || uiEvent === "composition") return true;

          // Allow undo/redo during composition - users should be able to undo mistakes
          // while still in IME input mode (especially important for CJK users)
          const historyMeta = tr.getMeta("history$");
          if (historyMeta) return true;

          // Allow doc-changing transactions during composition (#66),
          // EXCEPT heading splits — reject those so ProseMirror resets the
          // DOM and the composed text stays in the heading. The browser
          // incorrectly splits headings when accepting IME candidates;
          // by rejecting the transaction, we prevent the split entirely.
          if (tr.docChanged) {
            const startPos = anchor.at(tr.before);
            if (startPos !== null &&
                tr.before.childCount < tr.doc.childCount) {
              try {
                const $start = tr.before.resolve(startPos);
                if ($start.parent.type.name === "heading") {
                  // Verify a paragraph appeared immediately after the heading
                  const afterPos = $start.after($start.depth);
                  if (afterPos < tr.doc.content.size) {
                    const $after = tr.doc.resolve(afterPos);
                    if ($after.nodeAfter?.type.name === "paragraph") {
                      return false; // Reject the heading→paragraph split
                    }
                  }
                }
              } catch { /* stale pos — allow */ }
            }
            return true;
          }

          return false;
        },
        props: {
          handleKeyDown(view, event) {
            const grace = isProseMirrorInCompositionGrace(view);
            // Never claim a key ProseMirror only SYNTHESIZED — see compositionKeys.
            if (shouldGuardKeyEvent(event, grace)) {
              // Korean Hangul: Enter during composition confirms the syllable
              // AND requests a newline. We block it to prevent premature block
              // splitting, but queue a deferred split for after the grace
              // period so the newline intent is not lost (Tiptap #4108).
              if (
                event.key === "Enter" &&
                (isComposing || grace) &&
                compositionData &&
                HANGUL_RE.test(compositionData)
              ) {
                if (grace && !isComposing) {
                  // Enter during grace period (compositionend rAF already ran).
                  // Schedule splitBlock directly since no rAF callback will
                  // consume the flag.
                  if (pendingEnterTimer) clearTimeout(pendingEnterTimer);
                  const snapshotFrom = view.state.selection.from;
                  pendingEnterTimer = setTimeout(() => {
                    pendingEnterTimer = null;
                    if (!isComposing && view.state.selection.from === snapshotFrom) {
                      splitBlock(view.state, view.dispatch);
                    }
                  }, IME_GRACE_PERIOD_MS);
                } else {
                  pendingEnterAfterComposition = true;
                }
              }
              return true;
            }
            return false;
          },
          handleDOMEvents: {
            compositionstart(view) {
              isComposing = true;
              compositionData = "";
              compositionPinyin = "";
              splitDetected = false;
              pendingEnterAfterComposition = false;
              if (pendingEnterTimer) {
                clearTimeout(pendingEnterTimer);
                pendingEnterTimer = null;
              }

              // Multi-block selection fix (Tiptap #5416): if the selection
              // spans multiple blocks, pre-delete it so the composition
              // starts in a clean single block. Without this, ProseMirror
              // only deletes the first block, leaving orphaned content.
              const { from, to } = view.state.selection;
              if (typeof to === "number" && from !== to) {
                try {
                  const $from = view.state.doc.resolve(from);
                  const $to = view.state.doc.resolve(to);
                  if ($from.parent !== $to.parent) {
                    view.dispatch(view.state.tr.deleteSelection());
                  }
                } catch { /* pos out of range — skip pre-deletion */ }
              }
              anchor.begin(view.state.doc, view.state.selection.from);

              return false;
            },
            compositionupdate(_view, event) {
              const data = (event as CompositionEvent).data;
              compositionData = data ?? compositionData;
              return false;
            },
            compositionend(view, event) {
              isComposing = false;
              markProseMirrorCompositionEnd(view);
              const data = (event as CompositionEvent).data;
              compositionPinyin = compositionData;
              if (typeof data === "string" && data.length > 0) {
                compositionData = data;
              }

              // Flag cursor fix for tableHeader cells (Safari moves
              // composed text to TR level, ProseMirror shoves it back
              // but collapses cursor to cell start).
              const startPos = anchor.at(view.state.doc);
              if (startPos !== null && compositionData) {
                const depth = findTableCellDepth(view, startPos);
                if (depth !== null) {
                  try {
                    const cellNode = view.state.doc.resolve(startPos).node(depth);
                    if (cellNode.type.name === "tableHeader") {
                      pendingHeaderCursorFix = { data: compositionData };
                    }
                  } catch { /* stale pos */ }
                }
              }

              // Snapshot state before scheduling rAF — a new composition
              // session could start before the callback fires, corrupting
              // the mutable closure variables.
              const snapshotData = compositionData;
              const snapshotPinyin = compositionPinyin;
              const snapshotSplit = splitDetected;
              const composition = anchor.current();

              // Schedule cleanup via rAF as fallback for non-heading cases.
              // The filterTransaction prevention handles heading splits
              // synchronously, but normal pinyin cleanup still needs rAF.
              requestAnimationFrame(() => {
                // Stale callback — a new composition started before this fired
                if (anchor.current() !== composition) return;

                /* v8 ignore start -- @preserve reason: IME composition split fallback; requires real ProseMirror + IME interaction not reproducible in unit tests */
                if (snapshotSplit) {
                  // Heading was split but filterTransaction didn't prevent it
                  // (shouldn't happen, but defensive fallback)
                  splitDetected = false;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- domObserver is ProseMirror-internal and absent from EditorView's public types
                  (view as any).domObserver?.flush?.();
                  const { state } = view;
                  const splitPos = anchor.at(state.doc);
                  if (snapshotData && splitPos !== null) {
                    const fix = fixCompositionSplitBlock(
                      state, splitPos, snapshotData, snapshotPinyin,
                    );
                    if (fix) {
                      view.dispatch(fix);
                      anchor.end();
                      flushProseMirrorCompositionQueue(view);
                      return;
                    }
                  }
                }
                /* v8 ignore stop */
                // Normal pinyin cleanup, then the composition is over: nothing
                // may act on its anchor again.
                cleanUpAfterComposition(
                  view, anchor.at(view.state.doc), snapshotData, snapshotPinyin,
                );
                anchor.end();
                flushProseMirrorCompositionQueue(view);

                // Korean Hangul deferred Enter: dispatch splitBlock after
                // cleanup so the committed character is in place (Tiptap #4108).
                if (pendingEnterAfterComposition) {
                  pendingEnterAfterComposition = false;
                  if (pendingEnterTimer) clearTimeout(pendingEnterTimer);
                  // Snapshot selection so we don't split at a stale position
                  // if the user moves the cursor before the timer fires.
                  const enterFrom = view.state.selection.from;
                  pendingEnterTimer = setTimeout(() => {
                    pendingEnterTimer = null;
                    if (!isComposing && view.state.selection.from === enterFrom) {
                      splitBlock(view.state, view.dispatch);
                    }
                  }, IME_GRACE_PERIOD_MS);
                }
              });

              return false;
            },
            blur(view) {
              // Always cancel deferred Enter on blur — even if composition
              // already ended via compositionend (isComposing is false),
              // the timer may still be pending.
              pendingEnterAfterComposition = false;
              if (pendingEnterTimer) {
                clearTimeout(pendingEnterTimer);
                pendingEnterTimer = null;
              }
              if (!isComposing) return false;
              isComposing = false;
              anchor.end();
              compositionData = "";
              compositionPinyin = "";
              splitDetected = false;
              markProseMirrorCompositionEnd(view);
              requestAnimationFrame(() => {
                flushProseMirrorCompositionQueue(view);
              });
              return false;
            },
          },
        },
      }),
    ];
  },
});
