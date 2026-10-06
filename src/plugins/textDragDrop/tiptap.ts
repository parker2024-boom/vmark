/**
 * Text Drag-Drop Extension
 *
 * Purpose: Enables drag-and-drop text reordering within the WYSIWYG editor.
 *   Tauri's native drag-drop handler intercepts all browser drag events,
 *   breaking ProseMirror's built-in text DnD. This plugin re-implements
 *   text move using mousedown/mousemove/mouseup on selections.
 *
 * Pipeline: mousedown on selected text → mousemove to track position →
 *   show drop cursor → mouseup to execute text move via PM transaction
 *
 * Key decisions:
 *   - Uses mouse events (not drag events) since Tauri blocks browser DnD
 *   - Only activates when mousedown occurs inside an existing TextSelection
 *   - Shows a visual drop cursor line during the drag
 *   - Executes as a single ProseMirror transaction (undoable)
 *   - Uses tr.mapping for robust position tracking across structural changes
 *   - Cancels on Escape key press or window blur
 *
 * @module plugins/textDragDrop/tiptap
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import "./textDragDrop.css";

const pluginKey = new PluginKey("textDragDrop");

/** Minimum squared distance (px²) before initiating a drag. */
const DRAG_THRESHOLD_SQ = 25; // 5px squared

function createDropCursor(): HTMLElement {
  const el = document.createElement("div");
  el.className = "text-drag-drop-cursor";
  return el;
}

function positionDropCursor(view: EditorView, cursor: HTMLElement, pos: number): boolean {
  try {
    const coords = view.coordsAtPos(pos);
    cursor.style.top = `${coords.top}px`;
    cursor.style.height = `${coords.bottom - coords.top}px`;
    cursor.style.left = `${coords.left}px`;
    return true;
  } catch {
    return false;
  }
}

/** Per-view cleanup reference so each editor instance has its own drag state. */
const activeCleanupMap = new WeakMap<EditorView, () => void>();

/** Tiptap extension that enables drag-and-drop text reordering within the editor. */
export const textDragDropExtension = Extension.create({
  name: "textDragDrop",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        view(editorView) {
          return {
            destroy() {
              const fn = activeCleanupMap.get(editorView);
              if (fn) {
                fn();
                activeCleanupMap.delete(editorView);
              }
            },
          };
        },
        props: {
          handleDOMEvents: {
            mousedown(view: EditorView, event: MouseEvent): boolean {
              // Only handle left button
              if (event.button !== 0) return false;

              // Don't interfere with modifier keys (Shift-click extends selection)
              if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;

              const { state } = view;
              const { selection } = state;

              // Only activate for non-empty TextSelection
              if (!(selection instanceof TextSelection) || selection.empty) return false;

              // Check if click is inside the current selection
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!pos) return false;

              const clickPos = pos.pos;
              // Use exclusive end boundary
              if (clickPos < selection.from || clickPos >= selection.to) return false;

              // Cancel any previous drag session for this view
              const prevCleanup = activeCleanupMap.get(view);
              if (prevCleanup) {
                prevCleanup();
                activeCleanupMap.delete(view);
              }

              const startX = event.clientX;
              const startY = event.clientY;
              const from = selection.from;
              const to = selection.to;

              let dragActive = false;
              const dropCursor = createDropCursor();
              let currentDropPos: number | null = null;
              let rafId = 0;

              const handleMouseMove = (e: MouseEvent) => {
                if (!dragActive) {
                  const dx = e.clientX - startX;
                  const dy = e.clientY - startY;
                  // Compare squared distance
                  if (dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return;

                  // Activate drag
                  dragActive = true;
                  view.dom.classList.add("text-drag-active");
                  document.body.appendChild(dropCursor);
                }

                // Throttle position updates via rAF
                const clientX = e.clientX;
                const clientY = e.clientY;
                if (rafId) cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(() => {
                  rafId = 0;
                  const dropPosResult = view.posAtCoords({ left: clientX, top: clientY });
                  if (dropPosResult) {
                    currentDropPos = dropPosResult.pos;
                    if (positionDropCursor(view, dropCursor, currentDropPos)) {
                      dropCursor.style.display = "block";
                    }
                  } else {
                    // Mouse outside editor — clear drop target
                    currentDropPos = null;
                    dropCursor.style.display = "none";
                  }
                });
              };

              const handleMouseUp = (e: MouseEvent) => {
                // Flush pending rAF to get final drop position
                if (rafId) {
                  cancelAnimationFrame(rafId);
                  rafId = 0;
                  const finalPos = view.posAtCoords({ left: e.clientX, top: e.clientY });
                  if (finalPos) {
                    currentDropPos = finalPos.pos;
                  }
                }

                const wasActive = dragActive;
                const dropPos = currentDropPos;

                cleanup();

                if (!wasActive || dropPos === null) {
                  // Not a drag — set cursor at mouseup position
                  if (!wasActive) {
                    const upPos = view.posAtCoords({ left: e.clientX, top: e.clientY });
                    if (upPos) {
                      try {
                        const resolved = view.state.doc.resolve(upPos.pos);
                        const tr = view.state.tr.setSelection(
                          TextSelection.near(resolved)
                        );
                        view.dispatch(tr);
                      } catch {
                        // Position invalid — ignore
                      }
                    }
                  }
                  return;
                }

                // Don't move if dropping inside the original selection
                if (dropPos >= from && dropPos <= to) return;

                // Execute text move using mapping for robust position tracking
                try {
                  const slice = view.state.doc.slice(from, to);
                  let tr = view.state.tr;

                  // Always delete first, then map the drop position
                  tr = tr.delete(from, to);
                  const mappedDropPos = tr.mapping.map(dropPos);
                  tr = tr.replaceRange(mappedDropPos, mappedDropPos, slice);

                  // Place cursor at end of dropped text
                  const contentLength = to - from;
                  const endPos = mappedDropPos + contentLength;
                  try {
                    tr = tr.setSelection(
                      TextSelection.near(tr.doc.resolve(endPos))
                    );
                  } catch {
                    // If exact end position is invalid, try near the mapped drop
                    try {
                      tr = tr.setSelection(
                        TextSelection.near(tr.doc.resolve(mappedDropPos))
                      );
                    } catch {
                      // Give up on cursor placement — still dispatch the move
                    }
                  }

                  view.dispatch(tr);
                } catch {
                  // Transaction failed — don't crash, just cancel
                }
              };

              const handleKeyDown = (e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  cleanup();
                }
              };

              // Also cleanup on window blur
              const handleBlur = () => {
                cleanup();
              };

              const cleanup = () => {
                if (rafId) {
                  cancelAnimationFrame(rafId);
                  rafId = 0;
                }
                document.removeEventListener("mousemove", handleMouseMove);
                document.removeEventListener("mouseup", handleMouseUp);
                document.removeEventListener("keydown", handleKeyDown);
                window.removeEventListener("blur", handleBlur);
                view.dom.classList.remove("text-drag-active");
                dropCursor.remove();
                dragActive = false;
                activeCleanupMap.delete(view);
              };

              activeCleanupMap.set(view, cleanup);

              document.addEventListener("mousemove", handleMouseMove);
              document.addEventListener("mouseup", handleMouseUp);
              document.addEventListener("keydown", handleKeyDown);
              window.addEventListener("blur", handleBlur);

              // Prevent ProseMirror from immediately clearing the selection
              // on mousedown inside it (which it does to start a new selection)
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});
