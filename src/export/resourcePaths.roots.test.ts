// @vitest-environment node
// WI-RA22.4 — a workspace at a filesystem or drive root embeds its images, and an
// unsaved document is an explicit no-root that refuses every local path.
//
// Tauri's normalize re-appends a trailing separator, so a ROOT comes back as
// "//" (POSIX) or "D:\\\\" (Windows drive). `isInsideBase` used to append a
// separator to the root and look for that prefix, which no normalized path has
// — so a workspace opened at "/" or "D:\\" embedded no images at all, and the
// unsaved document's "/" root was safe only by that same accident.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/path", async () => {
  const port = await import("./__tests__/tauriNormalizePort");
  return {
    normalize: (path: string) => Promise.resolve(port.tauriNormalize(path)),
    join: (...parts: string[]) => Promise.resolve(port.tauriJoin(...parts)),
    dirname: (path: string) => Promise.resolve(port.tauriDirname(path)),
  };
});

import {
  getDocumentBaseDir,
  getExportContainmentRoot,
  isInsideBase,
  resolveRelativePath,
} from "./resourcePaths";

describe("isInsideBase with a root that ends in a separator", () => {
  it.each([
    ["/etc/passwd", "//"],
    ["/Users/t/a.png", "/"],
    ["/Users/t/图片/a.png", "//"],
    ["D:\\img\\a.png", "D:\\\\"],
    ["D:\\img\\a.png", "D:\\"],
    ["D:/img/a.png", "D:/"],
    ["/Users/t/a.png", "/Users/t/"],
    ["C:\\proj\\img\\a.png", "C:\\proj\\"],
  ])("%j is inside %j", (path, base) => {
    expect(isInsideBase(path, base)).toBe(true);
  });

  it.each([
    ["E:\\img\\a.png", "D:\\\\"],
    ["D:evil\\a.png", "D:\\\\"],
    ["relative/a.png", "//"],
    ["/Users/t-evil/a.png", "/Users/t/"],
    ["C:\\proj-evil\\a.png", "C:\\proj\\"],
    ["/etc/passwd", ""],
  ])("%j is not inside %j", (path, base) => {
    expect(isInsideBase(path, base)).toBe(false);
  });
});

describe("a workspace opened at the filesystem root", () => {
  const doc = "/Users/t/notes/doc.md";

  it("bounds the export by the root, so a shared assets folder embeds", async () => {
    const baseDir = await getDocumentBaseDir(doc);
    const containWithin = await getExportContainmentRoot(doc, "/");

    await expect(resolveRelativePath("../assets/a.png", baseDir, containWithin)).resolves.toBe(
      "/Users/t/assets/a.png",
    );
    await expect(resolveRelativePath("photo.png", baseDir, containWithin)).resolves.toBe(
      "/Users/t/notes/photo.png",
    );
    await expect(resolveRelativePath("/Users/t/other/b.png", baseDir, containWithin)).resolves.toBe(
      "/Users/t/other/b.png",
    );
  });

  it("still resolves relative paths from the document's own folder", async () => {
    const baseDir = await getDocumentBaseDir(doc);
    const containWithin = await getExportContainmentRoot(doc, "/");
    await expect(resolveRelativePath("图片/封面.png", baseDir, containWithin)).resolves.toBe(
      "/Users/t/notes/图片/封面.png",
    );
  });
});

describe("an unsaved document is an explicit no-root", () => {
  it.each([
    ["no workspace", null],
    ["a workspace at the root", "/"],
    ["an ordinary workspace", "/Users/t/project"],
  ])("with %s, refuses every local path", async (_label, workspaceRoot) => {
    const baseDir = await getDocumentBaseDir(null);
    const containWithin = await getExportContainmentRoot(null, workspaceRoot);

    const sources = ["/etc/passwd", "photo.png", "asset://localhost/%2Fetc%2Fpasswd"];
    const resolved = await Promise.all(
      sources.map((src) => resolveRelativePath(src, baseDir, containWithin)),
    );
    expect(resolved).toEqual([null, null, null]);
  });

  it("refuses even when a caller lets the containment root default to the base", async () => {
    const baseDir = await getDocumentBaseDir(null);
    await expect(resolveRelativePath("/etc/passwd", baseDir)).resolves.toBeNull();
    await expect(resolveRelativePath("photo.png", baseDir)).resolves.toBeNull();
  });

  it("is not a path any real directory can spell", async () => {
    const baseDir = await getDocumentBaseDir(null);
    expect(baseDir).not.toBe("/");
    expect(baseDir.startsWith("/")).toBe(false);
  });
});
