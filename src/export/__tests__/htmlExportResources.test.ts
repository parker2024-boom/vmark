// Audit 20260907 — two things exportHtml got wrong around resources:
//   #340: both templates kept their default `includeKaTeX = true`, so a
//         document with no math still shipped a CDN stylesheet in index.html
//         and the full KaTeX payload in standalone.html;
//   #336: the images `resolveResources` copies into assets/images/ were not in
//         `createdPaths`, so the failure cleanup that claims to remove what the
//         export created left them behind.
// The content pipeline (sanitizer, templates, styles, reader, theme, font
// embedder) is real; the Tauri fs plugin, the resource resolver and `fetch`
// are the faked boundaries, and jsdom supplies the DOM the sanitizer needs.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  failStandalone: false,
  /** Sources the STANDALONE (embedding) pass reports missing (audit #337). */
  standaloneMissing: [] as string[],
  fontDownloads: [] as string[],
  removeCalls: [] as string[],
  /** The lock's own bytes: release reads them back to check it is still ours. */
  lockText: null as string | null,
  renameCalls: [] as [string, string][],
  /** Text written per path — the published documents are read back from here. */
  written: new Map<string, string>(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  // The user's document folder pre-exists; everything inside it is created.
  exists: vi.fn(async (path: string) => path === "/out/Doc"),
  // Nothing this suite publishes over exists, so `lstat` is never reached for
  // a real path; it refuses one that is not there, like the real command.
  lstat: vi.fn(async (path: string) => {
    throw new Error(`ENOENT: ${path}`);
  }),
  mkdir: vi.fn(async () => {}),
  writeTextFile: vi.fn(async (path: string, text: string) => {
    if (state.failStandalone && path.endsWith("standalone.html")) {
      throw new Error("Simulated write failure");
    }
    if (path.endsWith(".vmark-export.lock")) state.lockText = text;
    state.written.set(path, text);
  }),
  writeFile: vi.fn(),
  rename: vi.fn(async (from: string, to: string) => {
    state.renameCalls.push([from, to]);
  }),
  copyFile: vi.fn(),
  remove: vi.fn(async (path: string) => {
    state.removeCalls.push(path);
    if (path.endsWith(".vmark-export.lock")) state.lockText = null;
  }),
  readTextFile: vi.fn(async (path: string) => {
    // The destination lock is the only file this suite reads back:
    // `releaseExportLock` refuses to remove a lock that is not its own (#332).
    if (path.endsWith(".vmark-export.lock") && state.lockText !== null) return state.lockText;
    throw new Error("ENOENT");
  }),
}));

vi.mock("@/utils/debug", () => ({ exportWarn: vi.fn() }));

// Vitest's CSS handling turns the `?raw` stylesheet asset into an empty string
// (see pdfHtmlTemplate.test.ts), so the KaTeX asset itself — the boundary — is
// supplied with a recognisable rule the standalone document must (not) carry.
const KATEX_RULE = ".katex{font:normal 1.21em KaTeX_Main}";
vi.mock("katex/dist/katex.min.css?raw", () => ({ default: ".katex{font:normal 1.21em KaTeX_Main}" }));
const KATEX_CDN = "cdn.jsdelivr.net/npm/katex";

vi.mock("../resourceResolver", () => ({
  resolveResources: async (_html: string, options: { mode: string }) => ({
    html: "<p>test</p>",
    report:
      options.mode === "folder"
        ? {
            resources: [
              { originalSrc: "cat.png", resolvedPath: "/docs/cat.png", exportSrc: "assets/images/cat.png", isRemote: false, found: true },
              { originalSrc: "https://x.example/r.png", resolvedPath: "", exportSrc: "https://x.example/r.png", isRemote: true, found: true },
              { originalSrc: "gone.png", resolvedPath: "/docs/gone.png", exportSrc: "data:image/svg+xml,placeholder", isRemote: false, found: false },
            ],
            resolved: [],
            missing: [{ originalSrc: "gone.png" }],
            totalSize: 0,
          }
        : {
            resources: [],
            resolved: [],
            missing: state.standaloneMissing.map((originalSrc) => ({ originalSrc })),
            totalSize: 0,
          },
  }),
}));
vi.mock("../resourcePaths", () => ({
  getDocumentBaseDir: async () => "/docs",
  getExportContainmentRoot: async () => "/docs",
}));

import { exportHtml } from "../htmlExport";
import { getUserFontFile } from "../fontEmbedder";

const JETBRAINS = getUserFontFile("jetbrains")!;

/** The network under the real font embedder: every font downloads. */
function fakeFetch(input: string | URL | Request): Promise<Response> {
  state.fontDownloads.push(String(input));
  return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
}

/** The text exportHtml wrote for a staged file, by its file name. */
function stagedText(name: string): string {
  const hits = [...state.written].filter(([path]) => path.endsWith(`/${name}`));
  expect(hits).toHaveLength(1);
  return hits[0][1];
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  state.failStandalone = false;
  state.standaloneMissing.length = 0;
  state.fontDownloads.length = 0;
  state.removeCalls.length = 0;
  state.lockText = null;
  state.renameCalls.length = 0;
  state.written.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exportHtml — KaTeX ships only when the document has math (#340)", () => {
  it("a document without math ships KaTeX in NEITHER document", async () => {
    const result = await exportHtml("<p>no math</p>", { outputPath: "/out/Doc" });
    expect(result.success).toBe(true);
    expect(stagedText("index.html")).not.toContain(KATEX_CDN);
    expect(stagedText("standalone.html")).not.toContain(KATEX_RULE);
    expect(state.fontDownloads).toEqual([]);
  });

  it("a document with math keeps KaTeX in both", async () => {
    const result = await exportHtml('<span class="katex">x</span>', { outputPath: "/out/Doc" });
    expect(result.success).toBe(true);
    expect(stagedText("index.html")).toContain(KATEX_CDN);
    expect(stagedText("standalone.html")).toContain(KATEX_RULE);
  });
});

// Since #332/#334 the export is staged: the image the resolver copied lives
// under the staging tree, goes with that tree on failure, and is published
// by rename on success — so it is the export's file in both directions.
describe("exportHtml — copied images belong to the export (#336)", () => {
  const STAGING = /^\/out\/Doc\/\.vmark-export-[^/]+$/;
  /** The destination lock's own removal (#332) — counted apart from the tree. */
  const LOCK = "/out/Doc/.vmark-export.lock";
  const treeRemovals = () => state.removeCalls.filter((p) => p !== LOCK);

  it("a failed export removes only its staging tree — the copied image with it, nothing at the destination", async () => {
    state.failStandalone = true;
    const result = await exportHtml("<p>test</p>", { outputPath: "/out/Doc" });
    expect(result.success).toBe(false);
    expect(treeRemovals()).toHaveLength(1);
    expect(treeRemovals()[0]).toMatch(STAGING);
    expect(state.renameCalls).toEqual([]);
    expect(state.removeCalls).toContain(LOCK);
  });

  it("a successful export publishes the copied image and not the remote or missing ones", async () => {
    const result = await exportHtml("<p>test</p>", { outputPath: "/out/Doc" });
    expect(result.success).toBe(true);
    const published = state.renameCalls.map(([, to]) => to);
    expect(published).toContain("/out/Doc/assets/images/cat.png");
    expect(published.filter((p) => p.includes("r.png"))).toEqual([]);
    expect(published.filter((p) => p.includes("gone.png"))).toEqual([]);
    // Only the staging tree is removed, after the publish.
    expect(treeRemovals()).toHaveLength(1);
    expect(treeRemovals()[0]).toMatch(STAGING);
    expect(state.removeCalls).toContain(LOCK);
  });
});

// Audit 20260907 (#337): the standalone (embedding) pass returned its own
// report, and exportHtml threw it away — a resource that failed only while
// being embedded was neither counted nor warned about.
describe("exportHtml — diagnostics from both resolution passes (#337)", () => {
  it("counts and warns about a resource missing only during embedding", async () => {
    state.standaloneMissing.push("embed-only.png");
    const result = await exportHtml("<p>test</p>", { outputPath: "/out/Doc" });
    expect(result.success).toBe(true);
    expect(result.missingCount).toBe(2);
    expect(result.warnings).toContain("2 resource(s) not found");
  });

  it("does not double-count a resource missing in both passes", async () => {
    state.standaloneMissing.push("gone.png");
    const result = await exportHtml("<p>test</p>", { outputPath: "/out/Doc" });
    expect(result.missingCount).toBe(1);
    expect(result.warnings).toContain("1 resource(s) not found");
  });
});

// Audit 20260907 (#339): the document and monospace font settings naming the
// same web font pushed the same FontFile twice — two downloads, two writes,
// two @font-face rules and a doubled size.
describe("exportHtml — a font shared by both settings is exported once (#339)", () => {
  it("downloads one file when fontFamily and monoFontFamily coincide", async () => {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    vi.mocked(writeFile).mockClear();
    const result = await exportHtml("<p>test</p>", {
      outputPath: "/out/Doc",
      fontSettings: { fontFamily: "jetbrains", monoFontFamily: "jetbrains" },
    });
    expect(result.success).toBe(true);
    expect(state.fontDownloads).toEqual([JETBRAINS.url]);
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(1);
  });
});
