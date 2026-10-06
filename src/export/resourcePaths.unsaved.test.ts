// @vitest-environment node
// WI-RA21.8 — an unsaved document's export embeds no local file.
//
// The audit read `getDocumentBaseDir(null)` → "/" as a containment root that
// admits every absolute path, so an unsaved document could embed, say,
// ~/.ssh/id_rsa into an HTML export. Verified NOT live: the containment check
// is `isInsideBase`, which needs the path to start with the root PLUS a
// separator, and Tauri's `normalize` turns "/" into "//" (it re-appends the
// trailing separator) while collapsing a leading "//" in any path to "/". So
// no normalized path is "inside" the unsaved root, and every local image of an
// unsaved document becomes the missing-image placeholder.
//
// That guarantee rested on two details nobody wrote down. The unsaved root is
// now an explicit no-root value, refused before any path arithmetic
// (WI-RA22.4), and this file keeps pinning the outcome. `tauriNormalize` is a
// line-for-line port of tauri 2's normalize (see its header).
import { describe, expect, it, vi } from "vitest";
import { tauriNormalize } from "./__tests__/tauriNormalizePort";

vi.mock("@tauri-apps/api/path", async () => {
  const port = await import("./__tests__/tauriNormalizePort");
  return {
    normalize: (path: string) => Promise.resolve(port.tauriNormalize(path)),
    join: (...parts: string[]) => Promise.resolve(port.tauriJoin(...parts)),
    dirname: (path: string) => Promise.resolve(port.tauriDirname(path)),
  };
});

import { getDocumentBaseDir, getExportContainmentRoot, resolveRelativePath } from "./resourcePaths";

describe("the ported normalize matches tauri on the inputs that decide this", () => {
  it.each([
    ["/", "//"],
    ["//etc/passwd", "/etc/passwd"],
    ["///etc/passwd", "/etc/passwd"],
    ["/Users/test/a/../b.png", "/Users/test/b.png"],
    ["", "."],
  ])("normalize(%j) is %j", (input, expected) => {
    expect(tauriNormalize(input)).toBe(expected);
  });
});

describe("an unsaved document embeds no local file", () => {
  const SOURCES = [
    "/Users/test/.ssh/id_rsa",
    "//Users/test/.ssh/id_rsa",
    "///etc/passwd",
    "photo.png",
    "../../etc/passwd",
    "%2FUsers%2Ftest%2F.ssh%2Fid_rsa",
    "asset://localhost/%2FUsers%2Ftest%2Fphoto.png",
    "https://asset.localhost/%2FUsers%2Ftest%2Fphoto.png",
  ];

  it.each([
    ["no workspace", null],
    ["a workspace open", "/Users/test/project"],
  ])("with %s, every spelling of a local path is refused", async (_label, workspaceRoot) => {
    const baseDir = await getDocumentBaseDir(null);
    const containWithin = await getExportContainmentRoot(null, workspaceRoot);

    const resolved = await Promise.all(SOURCES.map((src) => resolveRelativePath(src, baseDir, containWithin)));

    expect(resolved).toEqual(SOURCES.map(() => null));
  });

  it("a saved document still embeds the images in its own folder (the check is not refusing everything)", async () => {
    const doc = "/Users/test/notes/doc.md";
    const baseDir = await getDocumentBaseDir(doc);
    const containWithin = await getExportContainmentRoot(doc, null);

    await expect(resolveRelativePath("photo.png", baseDir, containWithin)).resolves.toBe("/Users/test/notes/photo.png");
    await expect(resolveRelativePath("/Users/test/notes/a.png", baseDir, containWithin)).resolves.toBe(
      "/Users/test/notes/a.png",
    );
    await expect(resolveRelativePath("/Users/test/.ssh/id_rsa", baseDir, containWithin)).resolves.toBeNull();
  });
});
