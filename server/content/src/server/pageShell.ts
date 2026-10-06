/**
 * The HTML every KB page is served in, and the escaping its dynamic text
 * goes through.
 *
 * Split out of `createServer.ts` to keep it under its size cap.
 *
 * @coordinates-with server/auth.ts — urlTokenFor decides whether subresource URLs carry the token
 * @coordinates-with server/createServer.ts — the routes that serve pages
 * @module server/pageShell
 */

/** A served page: the KB stylesheet and script around `body`. */
export function htmlShell(title: string, body: string, urlToken: string | null): string {
  // Asset URLs carry ?s only for a page served on it: the cookie-blocked
  // in-app iframe (grill M2). A page served on the cookie gets clean URLs —
  // its subresources send the cookie — so the token stays out of a browser's
  // history and logs (`auth.urlTokenFor`). kb.js propagates ?s to in-page
  // links + the SSE stream whenever the page URL has one.
  const q = urlToken === null ? "" : `?s=${encodeURIComponent(urlToken)}`;
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<link rel="stylesheet" href="/__assets/kb.css${q}">` +
    `</head><body><main class="kb-content">${body}</main>` +
    `<script src="/__assets/kb.js${q}"></script></body></html>`;
}

// grill M14 — strip Unicode bidi-control chars (RTL override etc.) so a crafted
// filename can't visually spoof entries in the served index list.
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏]/g;

/** Text made safe for HTML content and attribute values. */
export function escapeHtml(s: string): string {
  return s
    .replace(BIDI_CONTROLS, "")
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
