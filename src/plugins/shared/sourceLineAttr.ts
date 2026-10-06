/**
 * Shared attributes that record where a node came from in the markdown source.
 *
 * `sourceLine` is used for cursor sync between Source and WYSIWYG modes: it is
 * set during MDAST → ProseMirror conversion and represents the original line
 * number in the markdown source. `blankLinesBefore` and the list item's
 * `tightBefore` record source spacing, so a document is written back the way
 * it was read.
 *
 * @module plugins/shared/sourceLineAttr
 */

export const sourceLineAttr = {
  sourceLine: {
    default: null as number | null,
    // No parseHTML - sourceLine is only set programmatically during MDAST conversion
    // No renderHTML - sourceLine is internal, not rendered to DOM
  },
} as const;

/**
 * Interface for extensions that can be extended with additional attributes.
 */
interface ExtendableExtension {
  extend: (config: { addAttributes: () => Record<string, unknown> }) => ExtendableExtension;
}

/**
 * Extend a Tiptap node/mark/extension with sourceLine attribute.
 * Reduces boilerplate when adding cursor sync support to nodes.
 *
 * @example
 * const HeadingWithSourceLine = withSourceLine(Heading);
 *
 * @param extension - The Tiptap extension to extend
 * @returns Extended extension with sourceLine attribute
 */
export function withSourceLine<T extends ExtendableExtension>(extension: T): T {
  return extension.extend({
    addAttributes() {
      return {
        ...(this as unknown as { parent?: () => Record<string, unknown> }).parent?.(),
        ...sourceLineAttr,
      };
    },
  }) as T;
}

/**
 * Shared `blankLinesBefore` attribute — the number of blank lines that preceded
 * this block in the source (captured during MDAST→PM conversion), or null to
 * inherit the serializer's default. Internal like sourceLine: set only
 * programmatically, never parsed from or rendered to the DOM. Drives
 * blank-line preservation (.claude/adr/plans/20260721-blank-line-preservation.md).
 */
const blankLinesAttr = {
  blankLinesBefore: {
    default: null as number | null,
  },
} as const;

/** Extend a Tiptap block node with the blankLinesBefore attribute. */
export function withBlankLinesBefore<T extends ExtendableExtension>(extension: T): T {
  return extension.extend({
    addAttributes() {
      return {
        ...(this as unknown as { parent?: () => Record<string, unknown> }).parent?.(),
        ...blankLinesAttr,
      };
    },
  }) as T;
}

/**
 * Shared list-item `tightBefore` attribute — true when the source wrote this
 * item of a LOOSE list directly under the previous one, with no blank line
 * between them (set during MDAST→PM conversion; read by
 * `markdownPipeline/listItemGapJoin.ts`). Markdown-only: never rendered or read
 * from pasted HTML, and not copied to the new item when an item is split, so an
 * item the user creates takes the list's usual blank line.
 */
export const tightBeforeAttr = {
  tightBefore: {
    default: false,
    rendered: false,
    keepOnSplit: false,
    parseHTML: () => false,
  },
} as const;
