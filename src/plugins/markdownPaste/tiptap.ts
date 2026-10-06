/**
 * Markdown Paste Extension
 *
 * Purpose: Intercepts clipboard paste events in WYSIWYG mode and parses markdown-formatted
 * plain text into ProseMirror nodes instead of inserting raw text. This enables rich pasting
 * from markdown-aware sources without requiring HTML clipboard data.
 *
 * Pipeline: ClipboardEvent → shouldHandleMarkdownPaste (detection) →
 *           createMarkdownPasteTransaction (shared/markdownPasteSlice) → dispatch transaction
 *
 * Key decisions:
 *   - Defers to htmlPaste when substantial HTML is present (avoids double-handling)
 *   - 200K char limit prevents UI freezes on enormous pastes (the node-count cap
 *     lives with the slice builder in shared/markdownPasteSlice.ts)
 *   - Falls back to Tauri clipboard API when browser API is unavailable
 *   - Skips markdown parsing inside code blocks and multi-cursor selections
 *
 * @coordinates-with markdownPasteDetection.ts — heuristic to determine if text looks like markdown
 * @coordinates-with htmlPaste/tiptap.ts — HTML paste gets priority when HTML clipboard data exists
 * @coordinates-with shared/markdownPasteSlice.ts — parses markdown into the inserted slice
 * @coordinates-with pasteUtils.ts — shared helpers for code/multi-selection checks
 * @module plugins/markdownPaste/tiptap
 */
import { Extension } from "@tiptap/core";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { createMarkdownPasteTransaction } from "@/plugins/shared/markdownPasteSlice";
import { isMarkdownPasteCandidate } from "@/utils/markdownPasteDetection";
import { isSubstantialHtml } from "@/utils/htmlToMarkdown";
import { pasteError } from "@/utils/debug";
import { isMultiSelection, isSelectionInCode } from "@/utils/pasteUtils";

const markdownPastePluginKey = new PluginKey("markdownPaste");

const MAX_MARKDOWN_PASTE_CHARS = 200_000;

/** Decision parameters controlling whether a paste should be handled as markdown. */
export interface MarkdownPasteDecision {
  pasteMode: MarkdownPasteMode;
  /** Raw HTML from clipboard, if any */
  html: string;
}

function hasValidUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim());
}

/** Determines whether clipboard text should be parsed as markdown based on heuristics and settings. */
export function shouldHandleMarkdownPaste(
  state: EditorState,
  text: string,
  decision: MarkdownPasteDecision
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_MARKDOWN_PASTE_CHARS) return false;
  if (decision.pasteMode === "off") return false;
  // If HTML is present AND substantial, let htmlPaste handle it.
  // Exception: some sources provide HTML as a <pre>/<code> wrapper around markdown-ish plain text
  // (which would otherwise paste as a code block). In that case, prefer markdown parsing.
  if (decision.html && isSubstantialHtml(decision.html)) {
    const isOnlyCodeWrapper =
      /<(pre|code)[^>]*>/i.test(decision.html) &&
      !/<(h[1-6]|ul|ol|li|table|tr|td|th|strong|b|em|i|u|s|del|mark|a|img|blockquote|hr)\b/i.test(
        decision.html
      );
    if (!isOnlyCodeWrapper) return false;
  }
  if (isMultiSelection(state)) return false;
  if (isSelectionInCode(state)) return false;
  if (!state.selection.empty && hasValidUrl(trimmed)) return false;
  return isMarkdownPasteCandidate(trimmed);
}


async function readClipboardPlainText(): Promise<string> {
  try {
    const text = await readText();
    if (text) return text;
  } catch (error) {
    pasteError("Failed to read clipboard:", error);
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch (error) {
      pasteError("Failed to read web clipboard:", error);
    }
  }

  return "";
}

/** Options for the markdown-paste extension. */
export interface MarkdownPasteOptions {
  /**
   * Whether pasted markdown should be interpreted, asked fresh per paste.
   *
   * INJECTED — a plugin reaching the app's stores cannot ship as a standalone
   * extension (ADR-015).
   */
  getMode: () => MarkdownPasteMode;
  /** Whether soft breaks survive the paste. */
  getPreserveLineBreaks: () => boolean;
}

/**
 * How a markdown paste is interpreted in WYSIWYG.
 *
 * The plugin's OWN vocabulary, matching the app's setting today. Declared here
 * so the plugin does not depend on the app's type module — a type-only import
 * still pins it to this repo, which is what the coupling gate measures.
 *
 * Writing this by hand caught a real mistake: the first draft guessed
 * `"auto" | "always" | "never"` and the compiler rejected it against the real
 * `"auto" | "off"`. Copying an assumed shape is how a boundary goes wrong
 * quietly; the compiler makes it loud.
 */
export type MarkdownPasteMode = "auto" | "off";

function handlePaste(
  view: EditorView,
  event: ClipboardEvent,
  getMode: () => MarkdownPasteMode,
  getPreserveLineBreaks: () => boolean,
): boolean {
  const text = event.clipboardData?.getData("text/plain");
  if (!text) return false;

  const pasteMode = getMode();
  const html = event.clipboardData?.getData("text/html") ?? "";

  if (!shouldHandleMarkdownPaste(view.state, text, { pasteMode, html })) {
    return false;
  }

  const tr = createMarkdownPasteTransaction(view.state, text, {
    preserveLineBreaks: getPreserveLineBreaks(),
  });

  if (!tr) return false;

  event.preventDefault();
  view.dispatch(tr.scrollIntoView());
  return true;
}


/** Reads plain text from the clipboard and inserts it without markdown parsing. */
export async function triggerPastePlainText(view: EditorView): Promise<void> {
  if (view.state.selection.ranges.length > 1) return;

  const text = await readClipboardPlainText();
  if (!text) return;
  try {
    const { from, to } = view.state.selection;
    const tr = view.state.tr.insertText(text, from, to);
    view.dispatch(tr.scrollIntoView());
  } catch {
    // View may have been destroyed during clipboard read
  }
}

/** Tiptap extension that intercepts paste events and parses markdown-formatted plain text. */
export const markdownPasteExtension = Extension.create<MarkdownPasteOptions>({
  name: "markdownPaste",
  // "auto" with breaks not preserved — what a host with no settings wants.
  addOptions() {
    return { getMode: () => "auto" as MarkdownPasteMode, getPreserveLineBreaks: () => false };
  },
  addProseMirrorPlugins() {
    const { getMode, getPreserveLineBreaks } = this.options;
    return [
      new Plugin({
        key: markdownPastePluginKey,
        props: {
          handlePaste: (view, event) =>
            handlePaste(view, event, getMode, getPreserveLineBreaks),
        },
      }),
    ];
  },
});
