// Phase 1/4 — live HTTP: real socket, cookie handshake over the wire, port-file,
// watcher-driven index refresh. (Server-half evidence for spike S0.1.)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startKbServer, type RunningKbServer } from "./runtime";
import { SESSION_COOKIE } from "./auth";

let root: string;
let server: RunningKbServer | null = null;
const BOOTSTRAP = "live-token-xyz";

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/**
 * How long `until` polls for the watcher's rebuild before it reports what it
 * last read.
 *
 * Every test here binds a real socket, writes real files, drives a real
 * watcher and makes several HTTP round trips. The tests themselves run under
 * the package's liveness bound (`testTimeout` in server/content's
 * vitest.config.ts, the shared `LIVENESS_TIMEOUT_MS`), not a number of their
 * own: this file's first case once spent 5072ms against vitest's 5000ms
 * default when the machine was busy. This poll budget sits below that bound
 * so a rebuild that never lands fails with the poll's message, not a bare
 * test timeout.
 */
const WATCHER_POLL_TIMEOUT_MS = 30_000;

/**
 * Poll `read` until it reports `expected`, or fail after `WATCHER_POLL_TIMEOUT_MS`.
 *
 * Replaces a fixed `setTimeout(600)` that guessed at how long a debounced
 * watcher rebuild takes. A fixed sleep is wrong in both directions: it wastes
 * 600ms when the rebuild lands in 20ms, and it fails when a loaded machine
 * takes 700ms — the same wall-clock-as-correctness mistake as the timeout above.
 */
async function until(read: () => Promise<number>, expected: number): Promise<void> {
  await vi.waitFor(async () => expect(await read()).toBe(expected), {
    timeout: WATCHER_POLL_TIMEOUT_MS,
    interval: 25,
  });
}

/** Mint a nonce over the wire, bootstrap, return the session Cookie header. */
async function liveCookie(url: string): Promise<string> {
  const mint = await fetch(`${url}/__mint`, { headers: { authorization: `Bearer ${BOOTSTRAP}` } });
  const { nonce } = (await mint.json()) as { nonce: string };
  const boot = await fetch(`${url}/__auth?t=${nonce}`, { redirect: "manual" });
  const setCookie = boot.headers.get("set-cookie") ?? "";
  // Namespaced per workspace root (audit 20260906, MCP-C05).
  const m = new RegExp(`(${SESSION_COOKIE}[^=]*)=([^;]+)`).exec(setCookie)!;
  return `${m[1]}=${m[2]}`;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vmark-live-"));
});
afterEach(async () => {
  if (server) await server.close();
  server = null;
  await fs.rm(root, { recursive: true, force: true });
});

describe("startKbServer — live over a real socket", () => {
  it("binds loopback, writes a port-file, and gates with the cookie", async () => {
    await write("Home.md", "# Home\n\n[[Note]]");
    await write("Note.md", "note body");
    const portFile = path.join(root, ".port.json");
    server = await startKbServer({ root, bootstrapToken: BOOTSTRAP, portFile });

    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toContain("127.0.0.1");

    // Port-file written with port + token.
    const pf = JSON.parse(await fs.readFile(portFile, "utf8"));
    expect(pf).toMatchObject({ port: server.port, token: BOOTSTRAP });

    // Unauthenticated → 401.
    const unauth = await fetch(`${server.url}/__health`);
    expect(unauth.status).toBe(401);

    // Mint nonce (Bearer) → bootstrap → cookie.
    const cookie = await liveCookie(server.url);

    // Authenticated note render over the wire.
    const note = await fetch(`${server.url}/note/Home.md`, { headers: { cookie } });
    expect(note.status).toBe(200);
    const html = await note.text();
    expect(html).toContain("<h1>Home</h1>");
    expect(html).toContain('href="/note/Note.md"');
  });

  it("refreshes the index after a file is added (watcher)", async () => {
    await write("A.md", "a");
    server = await startKbServer({ root, bootstrapToken: BOOTSTRAP });
    // Captured into a const: `server` is a nullable `let`, and TypeScript
    // widens it back inside the polling closure below.
    const running = server;
    const cookie = await liveCookie(running.url);

    const before = (await (
      await fetch(`${running.url}/__health`, { headers: { cookie } })
    ).json()) as { docs: number };
    expect(before.docs).toBe(1);

    await write("B.md", "b");

    // Poll for the debounced watcher rebuild rather than guessing its duration.
    await until(async () => {
      const health = (await (
        await fetch(`${running.url}/__health`, { headers: { cookie } })
      ).json()) as { docs: number };
      return health.docs;
    }, 2);
  });
});
