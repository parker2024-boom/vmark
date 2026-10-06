/**
 * Media preview popup — thumbnail limits, media kinds, and the `src` resolver.
 *
 * The resolver is shared with the WYSIWYG image view and the block media node
 * views and lives in `plugins/shared/resolveMediaPath.ts`; it is re-exported
 * here for the preview view, and this plugin's tests exercise it against the
 * host seam.
 *
 * @coordinates-with plugins/shared/resolveMediaPath.ts — the implementation
 * @coordinates-with plugins/imagePreview/ImagePreviewView.ts — the view that calls this
 * @module plugins/imagePreview/resolveSrc
 */

export { resolveImageSrc } from "@/plugins/shared/resolveMediaPath";

/** Maximum thumbnail dimensions (used by the view for initial positioning). */
export const MAX_THUMBNAIL_WIDTH = 200;
export const MAX_THUMBNAIL_HEIGHT = 150;

/** Media type for preview rendering. */
export type MediaType = "image" | "video" | "audio";
