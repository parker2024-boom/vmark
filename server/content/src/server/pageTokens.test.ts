// WI-RA18.10 — a page's subresource URLs carry the session token only for a
// client that needed it: one that authenticated with `?s=` because its cookie
// cannot work (the in-app frame). A client whose cookie authenticated the page
// gets token-free URLs, the same rule the `/__auth` redirect applies.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildIndex, type WorkspaceIndex } from "../index/buildIndex";
import { createContentServer } from "./createServer";
import { SESSION_COOKIE } from "./auth";

let root: string;
let index: WorkspaceIndex;
const BOOTSTRAP = "test-bootstrap-token-456";

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/** A server, its cookie header, and the session token the cookie holds. */
async function authedServer() {
  index = await buildIndex(root);
  const { app } = createContentServer({ root, bootstrapToken: BOOTSTRAP, getIndex: () => index });
  const mint = await app.request("/__mint", { headers: { authorization: `Bearer ${BOOTSTRAP}` } });
  const { nonce } = (await mint.json()) as { nonce: string };
  const res = await app.request(`/__auth?t=${nonce}`, { redirect: "manual" });
  const m = new RegExp(`(${SESSION_COOKIE}[^=]*)=([^;]+)`).exec(res.headers.get("set-cookie") ?? "");
  return { app, cookie: `${m![1]}=${m![2]}`, token: decodeURIComponent(m![2]) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vmark-tok-"));
  await write("A.md", "# A\n\n![pic](pic.png)\n\n中文 [[B]]\n");
  await write("B.md", "# B\n");
  await write("pic.png", "not really a png");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe.each([
  ["the workspace index", "/"],
  ["a note", "/note/A.md"],
  ["the relationship graph", "/graph"],
])("%s", (_label, route) => {
  it("served on the cookie: no session token anywhere in the page", async () => {
    const { app, cookie, token } = await authedServer();
    const html = await (await app.request(route, { headers: { cookie } })).text();
    expect(html).toContain('href="/__assets/kb.css"');
    expect(html).toContain('src="/__assets/kb.js"');
    expect(html).not.toContain(token);
    expect(html).not.toContain("?s=");
  });

  it("served on `?s=`: subresources carry the token the page needed", async () => {
    const { app, token } = await authedServer();
    const q = `?s=${encodeURIComponent(token)}`;
    const html = await (await app.request(`${route}${q}`)).text();
    expect(html).toContain(`href="/__assets/kb.css${q}"`);
    expect(html).toContain(`src="/__assets/kb.js${q}"`);
  });
});

describe("a note's local images", () => {
  it("follow the page: token-free on the cookie, tokened on `?s=`, whichever request comes first", async () => {
    const { app, cookie, token } = await authedServer();
    const q = `?s=${encodeURIComponent(token)}`;

    const viaCookie = await (await app.request("/note/A.md", { headers: { cookie } })).text();
    const viaQuery = await (await app.request(`/note/A.md${q}`)).text();
    const viaCookieAgain = await (await app.request("/note/A.md", { headers: { cookie } })).text();

    expect(viaCookie).toContain('src="/asset/pic.png"');
    expect(viaQuery).toContain(`src="/asset/pic.png${q}"`);
    expect(viaCookieAgain).toContain('src="/asset/pic.png"');
    expect(viaCookieAgain).not.toContain(token);
  });

  it("load with the credential the page was served on", async () => {
    const { app, cookie, token } = await authedServer();
    const q = `?s=${encodeURIComponent(token)}`;
    expect((await app.request("/asset/pic.png", { headers: { cookie } })).status).toBe(200);
    expect((await app.request(`/asset/pic.png${q}`)).status).toBe(200);
    expect((await app.request("/asset/pic.png")).status).toBe(401);
  });
});
