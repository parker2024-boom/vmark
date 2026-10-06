/**
 * Preview navigation guard.
 *
 * Purpose: a rendered preview (raw HTML, SVG, a Mermaid or Graphviz diagram)
 * puts markup the DOCUMENT wrote inside the app's own page. An `<a href>` or a
 * `<form>` there keeps the webview's default action: a plain click, or a
 * submit, replaces the editor with whatever the document named — its page
 * inside the app's chrome, and the editor state gone. This module takes that
 * default away and hands the link to the caller instead.
 *
 * Key decisions:
 *   - Leaf-pure: it decides and prevents, and the caller supplies what
 *     "open" means, so a plugin can mount the guard without reaching into the
 *     app's services.
 *   - Prevention never depends on the opener. A surface with no opener still
 *     cannot navigate; it only has nothing useful to do with the click.
 *   - A `#fragment` cannot leave the document, so it is left to the page
 *     unless the caller can land it on a heading.
 *   - Only a primary single click opens. The second click of a double click
 *     and a non-primary button are prevented and otherwise ignored.
 *   - Listeners sit on the surface, not on the markup, so content that is
 *     re-rendered into the same surface is covered without re-arming.
 *
 * @coordinates-with plugins/linkPopup/tiptap.ts — the editor's own anchors, and every preview inside the editor
 * @coordinates-with lib/formats/adapters/svg.tsx, mermaid.tsx — the standalone previews
 * @coordinates-with plugins/mermaidPreview/MermaidPreviewView.ts — the Source-mode diagram popup
 * @module utils/previewNavigation
 */

const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/**
 * Selector for the elements whose click navigates: an anchor (HTML or SVG),
 * and an image map's `<area>`, which is an anchor by another name.
 */
export const LINK_ELEMENTS = "a, area";

/** What a surface does with a link the reader activated. */
export interface PreviewLinkHandlers {
  /** Open a link. Never called for a `#fragment`. */
  open?: (href: string) => void;
  /** Try a same-document jump to the element named `id`; true when it landed. */
  jumpTo?: (id: string) => boolean;
}

/**
 * The href an anchor was written with — `href`, or SVG's legacy `xlink:href`.
 * Null when it has neither, which is an anchor with no default action.
 */
export function anchorHref(anchor: Element): string | null {
  return anchor.getAttribute("href") ?? anchor.getAttributeNS(XLINK_NAMESPACE, "href");
}

/**
 * Take over a click on a document-controlled anchor: prevent the navigation,
 * and hand a primary single click to the caller's opener.
 */
export function handlePreviewAnchorClick(
  anchor: Element,
  event: MouseEvent,
  handlers: PreviewLinkHandlers,
): void {
  const written = anchorHref(anchor);
  if (written === null) return;
  const href = written.trim();
  const primaryClick = event.button === 0 && event.detail <= 1;

  if (href.startsWith("#")) {
    if (primaryClick && handlers.jumpTo?.(href.slice(1))) event.preventDefault();
    return;
  }

  event.preventDefault();
  if (primaryClick) handlers.open?.(href);
}

/** Take over a form submit: a document's form never posts from the app's page. */
export function preventPreviewSubmit(event: Event): void {
  event.preventDefault();
}

/**
 * Guard a preview surface. Returns the function that removes the guard.
 */
export function guardPreviewNavigation(
  surface: HTMLElement,
  handlers: PreviewLinkHandlers = {},
): () => void {
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest(LINK_ELEMENTS);
    if (anchor && surface.contains(anchor)) handlePreviewAnchorClick(anchor, event, handlers);
  };
  surface.addEventListener("click", onClick);
  surface.addEventListener("submit", preventPreviewSubmit);
  return () => {
    surface.removeEventListener("click", onClick);
    surface.removeEventListener("submit", preventPreviewSubmit);
  };
}
