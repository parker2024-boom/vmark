/**
 * Markdown → insertable ProseMirror slice
 *
 * Purpose: Parses markdown text into a Slice (or a selection-replacing
 * Transaction) that any WYSIWYG feature can insert: markdown paste, HTML paste
 * (after HTML → markdown), AI suggestions and genie results all use it.
 *
 * Key decisions:
 *   - Inline-only parse results are wrapped in a paragraph; empty results
 *     become one empty paragraph, so the slice is always block content.
 *   - A node-count cap (MAX_MARKDOWN_PASTE_NODES) bounds parse-tree
 *     complexity, which character count alone does not; over the cap the
 *     slice builder throws MarkdownPasteTooComplexError and the transaction
 *     builder returns null so callers fall back to plain-text insertion.
 *
 * @coordinates-with markdownPaste/tiptap.ts — the paste handler that inserts these transactions
 * @coordinates-with htmlPaste/tiptap.ts — inserts converted HTML through createMarkdownPasteTransaction
 * @module plugins/shared/markdownPasteSlice
 */
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Fragment, Slice, type NodeType } from "@tiptap/pm/model";
import { parseMarkdown } from "@/utils/markdownPipeline";
import type { MarkdownPipelineOptions } from "@/utils/markdownPipeline/types";
import { pasteError } from "@/utils/debug";

/**
 * Cap on the number of ProseMirror nodes produced by a markdown paste.
 * Character count alone doesn't bound parse-tree complexity — a 199KB paste
 * of deeply nested list items can produce tens of thousands of nodes and
 * freeze the main thread on dispatch. When the parsed content exceeds this
 * cap, the paste is rejected and falls through to plain-text insertion
 * (which is O(n) regardless of structure).
 */
const MAX_MARKDOWN_PASTE_NODES = 5_000;

/** Recursively count nodes in a Fragment, bailing out early at `limit`. */
function countNodesUpTo(content: Fragment, limit: number): number {
  let count = 0;
  let exceeded = false;
  content.descendants(() => {
    if (exceeded) return false;
    count += 1;
    if (count > limit) {
      exceeded = true;
      return false;
    }
    return true;
  });
  return count;
}

function ensureBlockContent(content: Fragment, paragraphType: NodeType | undefined): Fragment {
  if (content.childCount === 0 && paragraphType) {
    return Fragment.from(paragraphType.create());
  }
  const firstChild = content.firstChild;
  if (firstChild && !firstChild.isBlock && paragraphType) {
    return Fragment.from(paragraphType.create(null, content));
  }
  return content;
}

/**
 * Sentinel error thrown when the parsed markdown structure exceeds
 * `MAX_MARKDOWN_PASTE_NODES`. The caller catches this specific type to
 * distinguish "too complex" (fall back to plain text) from a generic
 * parse failure (just log and bail).
 */
export class MarkdownPasteTooComplexError extends Error {
  constructor(nodeCount: number) {
    super(
      `Parsed markdown has more than ${MAX_MARKDOWN_PASTE_NODES} nodes (${nodeCount}); ` +
        `refusing to insert to prevent UI freeze`,
    );
    this.name = "MarkdownPasteTooComplexError";
  }
}

/** Parses markdown text into a ProseMirror Slice suitable for insertion. */
export function createMarkdownPasteSlice(
  state: EditorState,
  markdown: string,
  options: MarkdownPipelineOptions = {}
): Slice {
  const parsed = parseMarkdown(state.schema, markdown, options);
  const content = ensureBlockContent(parsed.content, state.schema.nodes.paragraph);
  const nodeCount = countNodesUpTo(content, MAX_MARKDOWN_PASTE_NODES);
  if (nodeCount > MAX_MARKDOWN_PASTE_NODES) {
    throw new MarkdownPasteTooComplexError(nodeCount);
  }
  return Slice.maxOpen(content);
}

/** Creates a ProseMirror transaction that replaces the current selection with parsed markdown. */
export function createMarkdownPasteTransaction(
  state: EditorState,
  markdown: string,
  options: MarkdownPipelineOptions = {}
): Transaction | null {
  try {
    const slice = createMarkdownPasteSlice(state, markdown, options);
    return state.tr.replaceSelection(slice);
  } catch (error) {
    if (error instanceof MarkdownPasteTooComplexError) {
      // Log at info level — this is an expected backstop, not a bug.
      // Returning null tells the caller to fall back to plain-text paste.
      pasteError("Markdown paste exceeded node cap; falling back to plain text:", error.message);
    } else {
      pasteError("Failed to parse markdown:", error);
    }
    return null;
  }
}
