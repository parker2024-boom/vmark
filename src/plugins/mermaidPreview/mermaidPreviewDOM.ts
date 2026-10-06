/**
 * Mermaid Preview DOM Builder
 *
 * Constructs the popup container DOM for mermaid/SVG/markmap preview.
 * DOM creation only -- no state, and no behaviour of its own. The one
 * listener it mounts is the navigation guard on the content element, which
 * belongs to that element for as long as it exists: whatever is rendered into
 * it is the document's markup.
 *
 * @coordinates-with plugins/shared/hostLinks.ts — where a clicked link is opened
 * @module plugins/mermaidPreview/mermaidPreviewDOM
 */

import i18n from "@/i18n";
import { guardPreviewNavigation } from "@/utils/previewNavigation";
import { hostLinks } from "@/plugins/shared/hostLinks";
import { activeFilePathForCurrentWindow } from "@/plugins/shared/hostDocument";

/** Build the preview popup container with header, content, error, and resize handles. */
export function buildContainer(): HTMLElement {
  const container = document.createElement("div");
  container.className = "mermaid-preview-popup";
  container.style.display = "none";

  // Header with drag handle and zoom controls
  const header = document.createElement("div");
  header.className = "mermaid-preview-header";

  const title = document.createElement("span");
  title.className = "mermaid-preview-title";
  title.textContent = "Preview";

  // Zoom controls: - 100% +
  const zoomControls = document.createElement("div");
  zoomControls.className = "mermaid-preview-zoom";

  const zoomOut = document.createElement("button");
  zoomOut.className = "vm-icon-btn vm-icon-btn--sm mermaid-preview-zoom-glyph mermaid-preview-zoom-btn";
  zoomOut.dataset.action = "out";
  const zoomOutLabel = i18n.t("editor:plugin.zoomOut");
  zoomOut.title = zoomOutLabel;
  zoomOut.setAttribute("aria-label", zoomOutLabel);
  zoomOut.textContent = "\u2212";

  const zoomValue = document.createElement("span");
  zoomValue.className = "mermaid-preview-zoom-value";
  zoomValue.textContent = "100%";

  const zoomIn = document.createElement("button");
  zoomIn.className = "vm-icon-btn vm-icon-btn--sm mermaid-preview-zoom-glyph mermaid-preview-zoom-btn";
  zoomIn.dataset.action = "in";
  const zoomInLabel = i18n.t("editor:plugin.zoomIn");
  zoomIn.title = zoomInLabel;
  zoomIn.setAttribute("aria-label", zoomInLabel);
  zoomIn.textContent = "+";

  zoomControls.appendChild(zoomOut);
  zoomControls.appendChild(zoomValue);
  zoomControls.appendChild(zoomIn);

  header.appendChild(title);
  header.appendChild(zoomControls);

  const preview = document.createElement("div");
  preview.className = "mermaid-preview-content";
  // A link or a form in the rendered diagram must not navigate the app's
  // page. A clicked link opens through the host instead, resolved against the
  // document the diagram was written in — the active document when clicked.
  guardPreviewNavigation(preview, {
    open: (href) => hostLinks.open(href, activeFilePathForCurrentWindow()),
  });

  const error = document.createElement("div");
  error.className = "mermaid-preview-error";

  // Resize handles for corners and edges
  const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
  handles.forEach((pos) => {
    const handle = document.createElement("div");
    handle.className = `mermaid-preview-resize mermaid-preview-resize-${pos}`;
    handle.dataset.corner = pos;
    container.appendChild(handle);
  });

  container.appendChild(header);
  container.appendChild(preview);
  container.appendChild(error);

  return container;
}
