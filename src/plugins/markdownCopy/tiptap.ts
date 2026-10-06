/**
 * Markdown Copy Extension
 *
 * Purpose: two features in one plugin.
 *
 * 1. **Copy format**: Customizes text/plain clipboard content on copy/cut.
 *    When "markdown", converts the selection to markdown syntax instead of
 *    flattened plain text. Uses ProseMirror's `clipboardTextSerializer` prop.
 *
 * 2. **Copy on select**: Automatically copies selected text to clipboard
 *    on mouseup, similar to terminal behavior.
 *
 * Key decisions:
 *   - Copied markdown is the serializer's output for the selection
 *     (`serializeSlice`, shared with Source Peek), with only the blank lines
 *     around it removed. It is NOT cleaned further: every escape it holds
 *     keeps text from pasting back as something else (`\#` from becoming a
 *     heading, `\|` from splitting a table cell), and code is copied byte for
 *     byte.
 *   - The document's hard-break style is used, resolved the way a save
 *     resolves it, from the host seams (`hostSettings`, `hostDocument`).
 *
 * @coordinates-with utils/markdownPipeline/docFromSlice.ts — serializeSlice
 * @coordinates-with plugins/shared/hostSettings.ts — the hard-break setting
 * @coordinates-with plugins/shared/hostDocument.ts — the document's hard-break style
 * @module plugins/markdownCopy/tiptap
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Schema, Slice } from "@tiptap/pm/model";
import { serializeSlice } from "@/utils/markdownPipeline/docFromSlice";
import type { MarkdownPipelineOptions } from "@/utils/markdownPipeline/types";
import { resolveHardBreakStyle } from "@/utils/linebreaks";
import { hostSettings } from "@/plugins/shared/hostSettings";
import { hostDocument } from "@/plugins/shared/hostDocument";
import { clipboardWarn, markdownCopyWarn } from "@/utils/debug";
import { errorMessage } from "@/utils/errorMessage";

const markdownCopyPluginKey = new PluginKey("markdownCopy");

/**
 * Normalize whitespace for clipboard content.
 *
 * For PLAIN TEXT only (the default copy format), never for markdown:
 * 1. Trim trailing whitespace from each line
 * 2. Collapse runs of 3+ blank lines into a single blank line
 * 3. Trim leading/trailing blank lines from the whole string
 */
export function cleanTextForClipboard(text: string): string {
  let result = text;
  // 1. Trim trailing whitespace per line
  result = result.replace(/[^\S\n]+$/gm, "");
  // 2. Collapse multiple blank lines (3+ newlines → 2)
  result = result.replace(/\n{3,}/g, "\n\n");
  // 3. Trim leading/trailing blank lines
  result = result.trim();
  return result;
}

/**
 * Remove the blank lines before and the whitespace after copied markdown.
 *
 * Unlike `cleanTextForClipboard`, nothing inside is touched: trailing spaces
 * on a line are a hard break or part of code, and a run of blank lines inside
 * a fence is code. Used for every markdown copy, WYSIWYG and Source mode alike.
 */
export function trimMarkdownForClipboard(markdown: string): string {
  return markdown.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
}

/** The window the editor is in, or null when the host cannot say. */
function currentWindowLabel(): string | null {
  try {
    return hostDocument.currentWindowLabel();
  } catch (error) {
    // The host's lookup throws outside an app window; the document's own
    // style is then unknown and the setting decides.
    markdownCopyWarn("No window to read the hard-break style from:", error);
    return null;
  }
}

/** Serializer options for copied markdown: the ones a save of this document uses. */
function copyMarkdownOptions(): MarkdownPipelineOptions {
  const label = currentWindowLabel();
  return {
    hardBreakStyle: resolveHardBreakStyle(
      label === null ? "unknown" : hostDocument.activeHardBreakStyle(label),
      hostSettings.hardBreakStyleOnSave(),
    ),
    preserveBlankLines: hostSettings.preserveBlankLines(),
  };
}

/**
 * Serialize a Slice to markdown for the clipboard.
 * Returns null on failure (caller decides fallback).
 */
function serializeSliceAsMarkdown(schema: Schema, slice: Slice): string | null {
  try {
    return trimMarkdownForClipboard(serializeSlice(schema, slice, copyMarkdownOptions()));
  } catch (error) {
    markdownCopyWarn("Serialization failed:", error);
    return null;
  }
}

/**
 * Get text for the current selection, respecting copyFormat setting.
 */
/**
 * How copied content should be placed on the clipboard.
 *
 * The plugin's OWN vocabulary, matching the app's setting. Written by hand
 * rather than imported, because a type-only import still pins the plugin to
 * this repo — and writing it caught the mistake: the first draft guessed
 * `"markdown" | "text"` against the real `"default" | "markdown"`.
 */
export type CopyFormat = "default" | "markdown";

/** Options for the markdown-copy extension. */
export interface MarkdownCopyOptions {
  /**
   * Copy format and copy-on-select, asked fresh on every copy.
   *
   * INJECTED — a plugin reaching the app's stores cannot ship as a standalone
   * extension (ADR-015). Getters, so a settings change takes effect without
   * rebuilding the editor.
   */
  getCopyFormat: () => CopyFormat;
  getCopyOnSelect: () => boolean;
}

function getSelectionText(view: EditorView, getCopyFormat: () => CopyFormat): string {
  const { state } = view;
  const { from, to } = state.selection;
  if (from === to) return "";

  const copyFormat = getCopyFormat();

  if (copyFormat === "markdown") {
    const slice = state.doc.slice(from, to);
    const md = serializeSliceAsMarkdown(state.schema, slice);
    if (md !== null) return md;
  }

  return cleanTextForClipboard(state.doc.textBetween(from, to, "\n\n"));
}

/** Tiptap extension that serializes copied content as clean markdown on the clipboard. */
export const markdownCopyExtension = Extension.create<MarkdownCopyOptions>({
  name: "markdownCopy",
  // VMark's own defaults ("default" format, copy-on-select off), so an unbound
  // host behaves like the app rather than subtly differently.
  addOptions() {
    return { getCopyFormat: () => "default" as CopyFormat, getCopyOnSelect: () => false };
  },
  addProseMirrorPlugins() {
    const { getCopyFormat, getCopyOnSelect } = this.options;
    return [
      new Plugin({
        key: markdownCopyPluginKey,
        props: {
          clipboardTextSerializer(slice: Slice, view: EditorView) {
            if (getCopyFormat() !== "markdown") return "";

            return serializeSliceAsMarkdown(view.state.schema, slice) ?? "";
          },
          handleDOMEvents: {
            mouseup(view: EditorView) {
              if (!getCopyOnSelect()) return false;

              requestAnimationFrame(() => {
                if (view.isDestroyed) return;

                const text = getSelectionText(view, getCopyFormat);
                if (text) {
                  navigator.clipboard.writeText(text).catch((error: unknown) => {
                    clipboardWarn("Clipboard write failed:", errorMessage(error));
                  });
                }
              });

              return false;
            },
          },
        },
      }),
    ];
  },
});
