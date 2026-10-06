/**
 * Where `/__auth` may send a client once it has a session.
 *
 * Purpose: `next` is text from the request, and the redirect built from it can
 * carry the session token. A destination that leaves this server takes the
 * token with it, so `next` has to be a PATH on this origin and nothing else.
 *
 * Key decisions:
 *   - Judged by the URL parser a browser uses, not by the look of the first
 *     characters. `/\host`, `/<tab>/host` and `/..//host` all begin with one
 *     slash and all resolve to another host: a browser reads `\` as `/` and
 *     drops tabs and newlines before it parses.
 *   - The redirect is rebuilt from the PARSED url, so what is sent is what was
 *     judged — and the rebuilt path is checked again, because resolving dot
 *     segments can itself leave a `//host` prefix.
 *   - The base is a fixed placeholder origin. The request's own `Host` header
 *     is client text too, and is never consulted.
 *
 * @coordinates-with auth.ts — the only caller
 * @module server/redirectTarget
 */

/** A stand-in for "this server", so a relative reference has something to resolve against. */
const PLACEHOLDER_ORIGIN = "http://vmark-content-server.invalid";

/** `path?query#fragment` of a URL already known to be on the placeholder origin. */
function pathOf(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The same-origin path `next` names, normalized, or `null` when it names
 * anything else — another host, a scheme, a relative reference, nothing.
 */
export function sameOriginPath(next: string | undefined): string | null {
  if (!next || !next.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(next, PLACEHOLDER_ORIGIN);
  } catch {
    // Not a URL reference at all, so not a path on this server.
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  const path = pathOf(url);
  // Sent as a `Location`, a leading `//` would be read as a host.
  if (path.startsWith("//")) return null;
  return path;
}

/**
 * `path` with the session token as its `s` parameter — in the query, ahead of
 * any fragment, which a server never receives.
 */
export function withSessionToken(path: string, sessionToken: string): string {
  const url = new URL(path, PLACEHOLDER_ORIGIN);
  url.searchParams.set("s", sessionToken);
  return pathOf(url);
}
