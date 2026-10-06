// @vitest-environment node
// Audit R3 #685/#689 — the branches extracted out of `exportHtmlStaged`.
//
// These were only reachable through a whole staged export before, which is why
// each of them shipped: a font whose primary CDN refuses and whose fallback
// succeeds, a download that fails at the network beside one that arrives, two
// font settings naming one family, and a resource that resolves as a file copy
// and then fails to embed. They are asserted here directly so a regression is a
// unit failure rather than a silently wrong export folder. The real font
// embedder runs; `fetch` and the Tauri fs plugin are the faked boundaries.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  /** URLs fetched, in call order. */
  requested: [] as string[],
  /** URL -> bytes; a URL not listed here answers 404. */
  available: new Map<string, Uint8Array<ArrayBuffer>>(),
  /** URLs whose fetch REJECTS (a network failure) instead of answering. */
  rejecting: new Set<string>(),
  written: [] as string[],
  folderMissing: [] as string[],
  singleMissing: [] as string[],
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async (path: string) => {
    state.written.push(path);
  }),
}));

// The real font embedder runs; the network underneath it is the boundary.
function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  state.requested.push(url);
  if (state.rejecting.has(url)) return Promise.reject(new TypeError(`network refused ${url}`));
  const bytes = state.available.get(url);
  return Promise.resolve(bytes ? new Response(bytes) : new Response(null, { status: 404 }));
}

vi.mock("../resourceResolver", () => ({
  resolveResources: async (_html: string, options: { mode: string }) => ({
    html: options.mode === "folder" ? "<p>folder</p>" : "<p>single</p>",
    report:
      options.mode === "folder"
        ? {
            resources: [
              { originalSrc: "cat.png", exportSrc: "assets/images/cat.png", isRemote: false, found: true },
              { originalSrc: "https://x/r.png", exportSrc: "https://x/r.png", isRemote: true, found: true },
              { originalSrc: "gone.png", exportSrc: "data:image/svg+xml,x", isRemote: false, found: false },
            ],
            resolved: [],
            missing: state.folderMissing.map((originalSrc) => ({ originalSrc })),
            totalSize: 4096,
          }
        : {
            resources: [],
            resolved: [],
            missing: state.singleMissing.map((originalSrc) => ({ originalSrc })),
            totalSize: 0,
          },
  }),
}));

import { prepareExportFonts, resolveExportResources } from "../htmlExportAssets";
import { getKaTeXFontFiles, getUserFontFile } from "../fontEmbedder";

const KATEX = getKaTeXFontFiles();
const JETBRAINS = getUserFontFile("jetbrains")!;
const LITERATA = getUserFontFile("literata")!;

function makeStage() {
  const tracked: string[] = [];
  return {
    root: "/stage",
    path: (relative: string) => `/stage/${relative}`,
    track: (relative: string) => tracked.push(relative),
    tracked,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  state.requested.length = 0;
  state.available.clear();
  state.rejecting.clear();
  state.written.length = 0;
  state.folderMissing.length = 0;
  state.singleMissing.length = 0;
});

describe("resolveExportResources", () => {
  it("tracks only the local images the folder pass actually copied (#336)", async () => {
    const stage = makeStage();
    await resolveExportResources("<p>x</p>", "/docs", stage);
    // The remote image was never written and the missing one is a data-URI
    // placeholder, so neither is a file publication could move.
    expect(stage.tracked).toEqual(["assets/images/cat.png"]);
  });

  it("merges the missing sets of BOTH passes (#337)", async () => {
    state.folderMissing = ["gone.png"];
    state.singleMissing = ["gone.png", "unembeddable.png"];
    const result = await resolveExportResources("<p>x</p>", "/docs", makeStage());
    expect([...result.missing.keys()].sort()).toEqual(["gone.png", "unembeddable.png"]);
  });

  it("returns each pass's own body and the resolver's copied bytes", async () => {
    const result = await resolveExportResources("<p>x</p>", "/docs", makeStage());
    expect(result.indexContent).toBe("<p>folder</p>");
    expect(result.standaloneContent).toBe("<p>single</p>");
    expect(result.resourceCount).toBe(3);
    expect(result.bytesWritten).toBe(4096);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("prepareExportFonts", () => {
  it("ships no KaTeX fonts for a document with no math (#340)", async () => {
    for (const f of KATEX) state.available.set(f.url, new Uint8Array([1]));
    const result = await prepareExportFonts(false, undefined, makeStage());
    expect(state.requested).toEqual([]);
    expect(result).toEqual({ localCSS: "", embeddedCSS: "", bytesWritten: 0, warnings: [] });
  });

  it("downloads one file when both font settings name the same family (#339)", async () => {
    state.available.set(JETBRAINS.url, new Uint8Array([1, 2, 3]));
    const stage = makeStage();
    const result = await prepareExportFonts(
      false,
      { fontFamily: "jetbrains", monoFontFamily: "jetbrains" },
      stage,
    );
    expect(state.requested).toEqual([JETBRAINS.url]);
    expect(stage.tracked).toEqual([`assets/fonts/${JETBRAINS.filename}`]);
    expect(result.bytesWritten).toBe(3);
  });

  it("falls back to the secondary CDN when the primary returns nothing", async () => {
    for (const f of KATEX) state.available.set(f.fallbackUrl!, new Uint8Array([9]));
    const result = await prepareExportFonts(true, undefined, makeStage());
    for (const f of KATEX) {
      const primary = state.requested.indexOf(f.url);
      expect(primary).toBeGreaterThanOrEqual(0);
      expect(state.requested.indexOf(f.fallbackUrl!)).toBeGreaterThan(primary);
    }
    expect(result.warnings).toEqual([]);
    expect(result.localCSS).toContain("url('assets/fonts/KaTeX_Main-Regular.woff2') format('woff2')");
    // [9] in base64 — the fallback's bytes, embedded.
    expect(result.embeddedCSS).toContain("url('data:font/woff2;base64,CQ==') format('woff2')");
  });

  it("warns — and does not throw — when both URLs return nothing", async () => {
    const result = await prepareExportFonts(true, undefined, makeStage());
    expect(result.warnings).toHaveLength(KATEX.length);
    expect(result.warnings).toContain("Failed to download font: KaTeX_Main-Regular.woff2");
    expect(result.localCSS).toBe("");
    expect(result.embeddedCSS).toBe("");
  });

  it("keeps the fonts that arrived when another download fails at the network", async () => {
    // One CDN failing must not abandon a font that downloaded fine. The
    // failing download retries with backoff before giving up — fake timers.
    vi.useFakeTimers();
    state.rejecting.add(LITERATA.url);
    state.available.set(JETBRAINS.url, new Uint8Array([1, 2]));
    const stage = makeStage();
    const pending = prepareExportFonts(
      false,
      { fontFamily: "literata", monoFontFamily: "jetbrains" },
      stage,
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(stage.tracked).toEqual([`assets/fonts/${JETBRAINS.filename}`]);
    expect(result.localCSS).toContain(JETBRAINS.filename);
    expect(result.localCSS).not.toContain(LITERATA.filename);
    expect(result.warnings).toEqual([`Failed to download font: ${LITERATA.filename}`]);
  });

  it("writes each font under the stage, never under the destination", async () => {
    state.available.set(JETBRAINS.url, new Uint8Array([7]));
    await prepareExportFonts(false, { fontFamily: "jetbrains" }, makeStage());
    expect(state.written).toEqual([`/stage/assets/fonts/${JETBRAINS.filename}`]);
  });
});
