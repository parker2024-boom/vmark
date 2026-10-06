// @vitest-environment node
// WI-2.3 — tests for the file-link → editor-jump wiring (G5).
// Verifies that clicking a detected path opens a tab, seeds the doc, and
// carries the :line nav; plus the oversized-file and stat-failure guards. The
// real link provider detects the path in a terminal line; link *detection*
// edge cases are covered by fileLinkProvider.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileBytes } from "@/test/fileBytes";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

const h = vi.hoisted(() => ({
  stat: vi.fn(async (_p: string) => ({ size: 1024 })),
  readTextFile: vi.fn(async (_p: string) => "file contents"),
  createTab: vi.fn(() => "tab-1"),
  ingestExternalContent: vi.fn(),
  setPendingContentSearchNav: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({ stat: h.stat, readFile: (path: string) => fileBytes(h.readTextFile(path)) }));
vi.mock("@/stores/tabStore", () => ({
  useTabStore: { getState: () => ({ createTab: h.createTab }) },
}));
vi.mock("@/stores/documentStore", () => ({
  useDocumentStore: { getState: () => ({ ingestExternalContent: h.ingestExternalContent }) },
}));
vi.mock("@/services/persistence/workspaceStorage", () => ({ getCurrentWindowLabel: () => "main" }));
vi.mock("@/services/navigation/contentSearchNavigation", () => ({
  setPendingContentSearchNav: h.setPendingContentSearchNav,
}));

import { setupFileLinks } from "./setupFileLinks";

/** A terminal whose single buffer line is `text`; it records the provider. */
function makeTerm(text: string) {
  const providers: ILinkProvider[] = [];
  const term = {
    registerLinkProvider: vi.fn((p: ILinkProvider) => providers.push(p)),
    writeln: vi.fn(),
    buffer: { active: { getLine: () => ({ translateToString: () => text }) } },
  } as unknown as Terminal;
  return { term, providers };
}

/** Click the first link the registered provider detects in the line. */
function clickFirstLink(providers: ILinkProvider[]) {
  expect(providers).toHaveLength(1);
  let links: ILink[] | undefined;
  providers[0].provideLinks(1, (l) => {
    links = l;
  });
  expect(links?.length).toBeGreaterThan(0);
  links![0].activate({} as MouseEvent, links![0].text);
}

describe("setupFileLinks — activate wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.stat.mockResolvedValue({ size: 1024 });
    h.readTextFile.mockResolvedValue("file contents");
  });

  it("opens a tab, seeds the document, and carries the :line nav", async () => {
    const { term, providers } = makeTerm("error at /work/src/main.ts:42:7");
    setupFileLinks(term);

    clickFirstLink(providers);
    await vi.waitFor(() =>
      expect(h.setPendingContentSearchNav).toHaveBeenCalledWith("tab-1", 42, ""),
    );
    expect(h.createTab).toHaveBeenCalledWith("main", "/work/src/main.ts");
    expect(h.ingestExternalContent).toHaveBeenCalledWith(
      "tab-1",
      "file contents",
      "disk-open",
      { filePath: "/work/src/main.ts" },
    );
  });

  it("does not set nav when no line / line 0 is parsed", async () => {
    const noLine = makeTerm("see /work/src/main.ts");
    setupFileLinks(noLine.term);
    clickFirstLink(noLine.providers);
    await vi.waitFor(() => expect(h.createTab).toHaveBeenCalledWith("main", "/work/src/main.ts"));
    expect(h.setPendingContentSearchNav).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const lineZero = makeTerm("see /work/src/main.ts:0");
    setupFileLinks(lineZero.term);
    clickFirstLink(lineZero.providers);
    await vi.waitFor(() => expect(h.createTab).toHaveBeenCalled());
    expect(h.setPendingContentSearchNav).not.toHaveBeenCalled();
  });

  it("refuses files over the 10MB cap (no read, no tab, warns)", async () => {
    h.stat.mockResolvedValue({ size: 11 * 1024 * 1024 });
    const { term, providers } = makeTerm("wrote /work/huge.log:1");
    setupFileLinks(term);
    clickFirstLink(providers);
    await vi.waitFor(() =>
      expect(term.writeln).toHaveBeenCalledWith(expect.stringContaining("File too large")),
    );
    expect(h.readTextFile).not.toHaveBeenCalled();
    expect(h.createTab).not.toHaveBeenCalled();
  });

  it("surfaces a stat failure into the terminal and opens nothing", async () => {
    h.stat.mockRejectedValue(new Error("permission denied"));
    const { term, providers } = makeTerm("open /work/secret.key:1");
    setupFileLinks(term);
    clickFirstLink(providers);
    await vi.waitFor(() =>
      expect(term.writeln).toHaveBeenCalledWith(expect.stringContaining("Cannot open file")),
    );
    expect(h.createTab).not.toHaveBeenCalled();
  });
});
