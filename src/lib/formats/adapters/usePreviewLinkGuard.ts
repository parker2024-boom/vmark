/**
 * Navigation guard for a standalone preview surface.
 *
 * Purpose: a `.svg` or `.mmd` preview renders markup the document wrote
 * straight into the app's page, so an `<a>` or a `<form>` in it keeps the
 * webview's default — navigate away. This hook mounts the shared guard on the
 * preview element and routes an activated link to the app's opener.
 *
 * Key decisions:
 *   - A REF CALLBACK with cleanup, not a ref plus an effect. Each preview
 *     returns a different element per state (empty, invalid, rendered), and an
 *     effect keyed on the document path would leave the guard on an element
 *     that had already been replaced.
 *   - A relative link resolves against the previewed file, as a link in a
 *     markdown document resolves against that document.
 *
 * @coordinates-with utils/previewNavigation.ts — the guard itself
 * @coordinates-with services/navigation/linkOpen.ts — the opener
 * @module lib/formats/adapters/usePreviewLinkGuard
 */

import { useCallback, type RefCallback } from "react";
import { guardPreviewNavigation } from "@/utils/previewNavigation";
import { openLinkTarget } from "@/services/navigation/linkOpen";

/** A ref for the element that holds the rendered preview of the file at `path`. */
export function usePreviewLinkGuard(path: string | null): RefCallback<HTMLElement> {
  return useCallback(
    (surface: HTMLElement | null) => {
      if (!surface) return;
      return guardPreviewNavigation(surface, {
        open: (href) => void openLinkTarget(href, path, null),
      });
    },
    [path],
  );
}
