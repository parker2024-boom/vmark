/**
 * Inline Source Peek Plugin
 *
 * Provides inline split view for editing markdown source of ProseMirror blocks.
 *
 * @module plugins/sourcePeekInline
 */

export { sourcePeekInlineExtension, openSourcePeekInline, revertAndCloseSourcePeek } from "./tiptap";
export { isSourcePeekOpen } from "./sourcePeekActions";
