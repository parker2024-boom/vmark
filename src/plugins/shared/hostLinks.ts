/**
 * Purpose: the link opener a plugin hands a document's link to.
 *
 * A plugin that renders the document's own markup — a diagram, an SVG —
 * holds `<a href>` elements the document wrote. Taking away their navigation
 * is the plugin's job (`utils/previewNavigation.ts`); OPENING the link is the
 * app's: a URL goes to the scheme-allowlisted OS opener, a file path to a
 * tab, resolved against the document it was written in. The plugin says which
 * link and which document, and the host decides what "open" means.
 *
 * Separate from `hostPopups`: those open editor chrome; this leaves the editor
 * for whatever the link names.
 *
 * The default is a NO-OP, as for the rest of the host chrome: a plugin lifted
 * out of this repo still prevents the navigation, it only has nowhere to send
 * the link.
 *
 * @coordinates-with services/assembly/bindHostSettings.ts — the app's binding
 * @coordinates-with utils/previewNavigation.ts — the guard that hands links here
 * @module plugins/shared/hostLinks
 */

/** How a plugin opens a link the document wrote. */
export interface HostLinks {
  /**
   * Open `href`, written in the document at `sourcePath`.
   *
   * `sourcePath` is what a relative link resolves against; null is a real
   * answer — an untitled document has no path, and a relative link in it has
   * nothing to resolve against.
   */
  open: (href: string, sourcePath: string | null) => void;
}

/** Nowhere to open a link — the plugin's guard still holds. */
const DEFAULTS: HostLinks = {
  open: () => {},
};

let bound: HostLinks = DEFAULTS;

/** Bind the host's link opener. Called once, at app startup. */
export function bindHostLinks(links: Partial<HostLinks>): void {
  bound = { ...DEFAULTS, ...links };
}

/** Restore defaults. Tests only. */
export function resetHostLinks(): void {
  bound = DEFAULTS;
}

/** The bound opener, read through an accessor so it is never captured stale. */
export const hostLinks: HostLinks = {
  open: (href, sourcePath) => bound.open(href, sourcePath),
};
