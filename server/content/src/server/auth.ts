/**
 * ADR-9 auth: one-time nonce → HttpOnly session cookie.
 *
 * A per-request header scheme is impossible for the external browser, static
 * assets, SSE, and Slidev HMR (review D1.2). And the long-lived port-file token
 * must never appear in a URL (browser history) — security review VULN-001.
 *
 * Flow:
 *   1. VMark (which holds the port-file `bootstrapToken`) calls `GET /__mint`
 *      with `Authorization: Bearer <bootstrapToken>` → receives a single-use,
 *      short-TTL nonce. This is a loopback fetch (no browser history).
 *   2. VMark navigates the webview/browser to `/__auth?t=<nonce>`. The server
 *      validates the nonce (single-use + TTL), sets an HttpOnly, SameSite=Strict
 *      session cookie, and redirects. The long-lived token is never in a URL.
 *   3. All later requests authenticate via the cookie — or, for a client that
 *      cannot hold one, via the SESSION token in `?s=`.
 *
 * Who gets the session token in a URL, and why:
 *
 * | Client | Cookie usable? | Gets `?s=` |
 * |---|---|---|
 * | External browser (top-level navigation) | yes — first-party | no |
 * | In-app frame (cross-site sub-frame of the app's page) | no — a `SameSite=Strict` cookie is never sent from a cross-site frame, and WebKit refuses to store one there at all | yes |
 * | The app's own loopback client (reads the 302, follows nothing) | no cookie jar | yes |
 *
 * The token in a URL is the price of the last two, not a convenience: it lands
 * in whatever records URLs. So a browser NAVIGATION is not told the token until
 * it has shown it cannot use the cookie. The first hop sets the cookie and
 * redirects to a single-use probe on this same endpoint; the probe sees whether
 * the cookie came back, and only a client that did not return it is redirected
 * with `?s=`. The decision rests on the property that matters — did the cookie
 * work — not on guessing what kind of client is asking. A request that is not
 * a navigation follows no redirect, so it is answered in one hop, as before.
 *
 * @module server/auth
 */

import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sameOriginPath, withSessionToken } from "./redirectTarget";

/**
 * The base session cookie name. Instances append a namespace — see
 * {@link sessionCookieName}.
 */
export const SESSION_COOKIE = "vmark_cs_session";

/**
 * The session cookie name for one workspace server.
 *
 * Cookies are scoped by HOST, never by PORT. Every workspace's content server
 * runs on `127.0.0.1` with an OS-assigned port and mints its own incompatible
 * session token, so with one shared cookie name the second workspace to
 * authenticate overwrote the first's cookie and the first started returning
 * 401 — with two ordinary previews open and no attacker anywhere.
 *
 * The namespace is derived from the workspace ROOT rather than being random,
 * and that is the point: restarting the same workspace REPLACES its cookie
 * instead of leaving another one behind, so the jar stays bounded by the
 * number of workspaces rather than by the number of launches.
 */
function sessionCookieName(namespace?: string): string {
  if (!namespace) return SESSION_COOKIE;
  // Hashed, so a workspace path never appears in a cookie name, and the name
  // stays a valid cookie token whatever the path contains.
  const digest = createHash("sha256").update(namespace).digest("hex").slice(0, 12);
  return `${SESSION_COOKIE}_${digest}`;
}
const BOOTSTRAP_PARAM = "t";
/** Query parameter of the cookie probe a browser navigation is redirected to. */
const PROBE_PARAM = "c";
/** One-time nonce lifetime. A probe, redeemed by the very next request, shares it. */
export const NONCE_TTL_MS = 120_000;

/** Constant-time string compare to avoid timing oracles. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface AuthGuard {
  middleware: ReturnType<typeof createMiddleware>;
  /** `GET /__mint` — Bearer-authed; returns `{ nonce }`. */
  handleMint: (c: import("hono").Context) => Response | Promise<Response>;
  /**
   * `GET /__auth?t=<nonce>` — consumes a nonce, sets the session cookie, and
   * redirects; `GET /__auth?c=<probe>` — the second hop of a browser
   * navigation, which decides whether the token must ride in the URL.
   */
  handleBootstrap: (c: import("hono").Context) => Response | Promise<Response>;
  /** How many probes are outstanding (bounded by eviction; read by tests). */
  pendingProbes: () => number;
  /** Mint a one-time nonce directly (used by tests / in-process callers). */
  mintNonce: (now?: number) => string;
  /** True if the request carries the correct `Authorization: Bearer <bootstrap>`. */
  checkBearer: (c: import("hono").Context) => boolean;
  /**
   * The token a page served to this request writes into its subresource
   * URLs, or null when the request's cookie authenticated it.
   */
  urlTokenFor: (c: import("hono").Context) => string | null;
  readonly sessionToken: string;
  /** The cookie name this instance reads and sets. */
  readonly cookieName: string;
}

export interface AuthOptions {
  bootstrapToken: string;
  redirectTo?: string;
  /** Injectable clock for deterministic TTL tests. */
  now?: () => number;
  /**
   * Distinguishes this instance's cookie from every other workspace server on
   * `127.0.0.1` — normally the workspace root path. Omitted only where a
   * single server exists (standalone tests).
   */
  cookieNamespace?: string;
}

export function createAuthGuard(options: AuthOptions): AuthGuard {
  const sessionToken = randomBytes(32).toString("hex");
  const cookieName = sessionCookieName(options.cookieNamespace);
  const redirectTo = options.redirectTo ?? "/";
  const clock = options.now ?? (() => Date.now());
  /** nonce → expiry epoch ms (single-use: deleted on consume). */
  const nonces = new Map<string, number>();

  const mintNonce = (now = clock()): string => {
    // grill L2 — evict expired nonces on each mint so the map can't grow
    // unbounded under mint-without-consume.
    for (const [n, expiry] of nonces) if (expiry <= now) nonces.delete(n);
    const nonce = randomBytes(32).toString("hex");
    nonces.set(nonce, now + NONCE_TTL_MS);
    return nonce;
  };

  const consumeNonce = (nonce: string, now = clock()): boolean => {
    const expiry = nonces.get(nonce);
    if (expiry === undefined) return false;
    nonces.delete(nonce); // single-use regardless of outcome
    return expiry > now;
  };

  /**
   * probe → where it leads and when it lapses. A table of its own, so a probe
   * can never be spent as a nonce or a nonce as a probe. The destination is
   * kept HERE, already validated, rather than carried back through the URL.
   */
  const probes = new Map<string, { dest: string; expiry: number }>();

  const mintProbe = (dest: string, now = clock()): string => {
    // Evicted on mint, like nonces: an abandoned navigation leaves one behind.
    for (const [p, entry] of probes) if (entry.expiry <= now) probes.delete(p);
    const probe = randomBytes(32).toString("hex");
    probes.set(probe, { dest, expiry: now + NONCE_TTL_MS });
    return probe;
  };

  const consumeProbe = (probe: string, now = clock()): string | null => {
    const entry = probes.get(probe);
    if (entry === undefined) return null;
    probes.delete(probe); // single-use regardless of outcome
    return entry.expiry > now ? entry.dest : null;
  };

  const bearer = (c: import("hono").Context): string | null => {
    const h = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1] : null;
  };

  const hasSessionCookie = (c: import("hono").Context): boolean => {
    const cookie = getCookie(c, cookieName);
    return cookie != null && safeEqual(cookie, sessionToken);
  };

  const middleware = createMiddleware(async (c, next) => {
    const p = c.req.path;
    if (p === "/__auth" || p === "/__mint") return next(); // self-authenticating
    // Accept the cookie (external browser — first-party cookies work) OR a
    // session token in `?s=`. The query path is REQUIRED for the in-app
    // cross-site iframe: WKWebView's ITP blocks third-party cookie STORAGE for
    // a cross-site loopback origin, so a cookie can never be set there — the URL
    // session token is the only viable credential (grill M2, found via E2E).
    // `/__auth` hands that token only to a client that needs it.
    const queryToken = c.req.query("s");
    const ok =
      hasSessionCookie(c) || (queryToken != null && safeEqual(queryToken, sessionToken));
    if (!ok) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  const handleMint = (c: import("hono").Context): Response => {
    const provided = bearer(c);
    if (!provided || !safeEqual(provided, options.bootstrapToken)) {
      return c.json({ error: "invalid bootstrap token" }, 403);
    }
    return c.json({ nonce: mintNonce() });
  };

  /** Second hop of a browser navigation: did the cookie come back? */
  const finishProbe = (c: import("hono").Context, probe: string): Response => {
    const dest = consumeProbe(probe);
    if (dest === null) return c.json({ error: "invalid or expired probe" }, 403);
    // It did: the browser is authenticated and the token stays out of its URLs.
    // It did not: this client cannot use the cookie, so the token is its only
    // credential (see the table in the module header).
    return c.redirect(hasSessionCookie(c) ? dest : withSessionToken(dest, sessionToken), 302);
  };

  const handleBootstrap = (c: import("hono").Context): Response => {
    const probe = c.req.query(PROBE_PARAM);
    if (probe !== undefined) return finishProbe(c, probe);

    const provided = c.req.query(BOOTSTRAP_PARAM) ?? "";
    if (!provided || !consumeNonce(provided)) {
      return c.json({ error: "invalid or expired nonce" }, 403);
    }
    setCookie(c, cookieName, sessionToken, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    // Optional `next` (e.g. /slidev/): a path on this server, or it is ignored.
    const dest = sameOriginPath(c.req.query("next")) ?? redirectTo;
    // A navigation follows the redirect and can be probed. Anything else — the
    // app's own loopback client, which reads this 302 and follows nothing —
    // has no cookie jar to probe and takes the token here.
    if (c.req.header("sec-fetch-mode") === "navigate") {
      return c.redirect(`/__auth?${PROBE_PARAM}=${mintProbe(dest)}`, 302);
    }
    return c.redirect(withSessionToken(dest, sessionToken), 302);
  };

  /**
   * The token a page served to this request writes into its own URLs —
   * stylesheet, script, images — or null when the request's cookie
   * authenticated it, so the subresources it loads send the cookie too.
   * The same rule as the `/__auth` redirect: the token goes into a URL only
   * for a client that has shown the cookie does not work for it.
   */
  const urlTokenFor = (c: import("hono").Context): string | null =>
    hasSessionCookie(c) ? null : sessionToken;

  const checkBearer = (c: import("hono").Context): boolean => {
    const provided = bearer(c);
    return provided != null && safeEqual(provided, options.bootstrapToken);
  };

  return {
    middleware,
    handleMint,
    handleBootstrap,
    pendingProbes: () => probes.size,
    mintNonce,
    checkBearer,
    urlTokenFor,
    sessionToken,
    cookieName,
  };
}
