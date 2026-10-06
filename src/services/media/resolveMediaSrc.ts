/**
 * Shared Media Source Resolution
 *
 * Purpose: Resolves media src attributes (image, audio, video) from markdown
 * node attributes to loadable URLs — handles external URLs, absolute paths,
 * and relative paths resolved against the active document's directory.
 *
 * Key decisions:
 *   - The OWNING tab may be passed explicitly; only a caller with no owner
 *     falls back to the focused tab. A split view has two owners at once.
 *   - The resolution algorithm itself is plugins/shared/resolveMediaPath.ts, shared
 *     with the inline image resolvers; this module supplies the owning document's
 *     path from the stores and the block-media verdict (refuse, never pass through)
 *   - withMediaReloadKey() appends a version to that URL so a file changed on
 *     disk is re-fetched: an element whose `src` is unchanged never reloads,
 *     and the webview's cache defeats a fresh element too (issue #1328)
 *   - Security: a relative path may contain `..` and is resolved against the
 *     document's directory (#1433); what is refused is a directory-naming or
 *     home-relative path, and any source carrying a URI scheme this module does not serve
 *     (`javascript:`, `file:`, a custom one) is REFUSED rather than returned —
 *     the closing `return src` used to hand it back into an element's `src`.
 *     Shared refusal table: src/test/adversarialMediaSources.ts
 *
 * @coordinates-with plugins/shared/resolveMediaPath.ts — the shared resolution algorithm
 * @coordinates-with stores/documentStore.ts — document file path lookup
 * @coordinates-with stores/tabStore.ts — active tab lookup
 * @module services/media/resolveMediaSrc
 */

import { useDocumentStore } from "@/stores/documentStore";
import { useTabStore } from "@/stores/tabStore";
import { getWindowLabel } from "@/services/navigation/windowFocus";
import { normalizePathForAsset, resolveMediaPath } from "@/plugins/shared/resolveMediaPath";
import { imageViewWarn, resolveMediaError } from "@/utils/debug";

// Defined beside the resolver that uses it; re-exported for this module's callers.
export { normalizePathForAsset };

/**
 * Append a reload key to an `asset://` URL so a changed file is re-fetched.
 *
 * An `<img>` / `<video>` whose `src` attribute does not change never refetches,
 * and the webview's cache means even a BRAND-NEW element pointed at the same
 * URL is served the bytes it already holds. Measured against real WebKit while
 * fixing issue #1328: with a 64×64 PNG open and a 96×96 one written over it,
 * a fresh `new Image()` on the unchanged URL still decoded 64×64, while the
 * same URL plus a query parameter decoded 96×96. So the URL has to move, and a
 * remount alone cannot substitute for it.
 *
 * `key === 0` returns the URL untouched: that is the state of every media view
 * that has never seen an external change, and a bare URL is what the existing
 * tests, the Quick Look overlay and the asset scope all already exercise.
 *
 * The parameter rides in the QUERY, which the asset protocol resolves the file
 * path independently of — verified live, not assumed.
 */
export function withMediaReloadKey(assetUrl: string, key: number): string {
  if (!Number.isFinite(key) || key <= 0) return assetUrl;
  return `${assetUrl}${assetUrl.includes("?") ? "&" : "?"}v=${key}`;
}

/**
 * Get the active tab ID for the current window.
 * Returns null if no active tab or if the window label cannot be determined.
 */
export function getActiveTabIdForCurrentWindow(): string | null {
  try {
    const windowLabel = getWindowLabel();
    return useTabStore.getState().activeTabId[windowLabel] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a media src attribute to a loadable URL.
 *
 * - External URLs (http, https, data:, asset://, tauri://) pass through unchanged
 * - Absolute paths are converted via convertFileSrc with Windows normalization
 * - Relative paths are resolved against the active document's directory
 * - A URI scheme, a home-relative path or a path naming a directory returns ""
 *
 * @param src - Raw src from node attributes
 * @param logPrefix - Optional prefix for console warnings (e.g., "[BlockImageView]")
 * @param ownerTabId - The tab whose document owns this src. Omit only when the
 *   caller genuinely has no owner (then the focused tab is used).
 * @returns Resolved URL suitable for element src
 */
export function resolveMediaSrc(
  src: string,
  logPrefix = "[Media]",
  ownerTabId?: string,
): Promise<string> {
  return resolveMediaPath(src, {
    // The OWNING document decides what a relative path means, not whichever
    // tab happens to have focus. A caller with no owner to offer falls back to
    // the focused tab, but one that knows its document must say so: with two
    // documents open in a split (#1081), resolving against the focused tab
    // gave the unfocused pane the other document's directory, and changed its
    // answer as focus moved.
    documentPath: () => {
      const tabId = ownerTabId ?? getActiveTabIdForCurrentWindow();
      const doc = tabId ? useDocumentStore.getState().getDocument(tabId) : undefined;
      return doc?.filePath ?? null;
    },
    // Block media refuses what it cannot resolve rather than handing it back.
    unresolvablePath: "refuse",
    onRefused: (decodedSrc) => imageViewWarn(`${logPrefix} Rejected media path:`, decodedSrc),
    onError: (error) => resolveMediaError("Failed to resolve media path:", error),
  });
}
