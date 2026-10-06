// @vitest-environment node
// WI-RA19.4 — every FileErrors message goes through i18n. They were English
// template literals, so a rename collision ("A file named … already exists")
// and every other file-operation failure read in English in every locale.
// i18n is replaced by a marker translator: a message that bypasses t() comes
// back as plain English instead of a marker.
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(async () => undefined) }));
vi.mock("@/i18n", () => ({
  default: {
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `<${key}|${JSON.stringify(opts)}>` : `<${key}>`,
  },
}));

import { FileErrors } from "./errorDialog";

describe("FileErrors are translated", () => {
  it.each([
    ["fileExists", "dialog:fileError.fileExists"],
    ["folderExists", "dialog:fileError.folderExists"],
    ["createFailed", "dialog:fileError.createFailed"],
    ["renameFailed", "dialog:fileError.renameFailed"],
    ["deleteFailed", "dialog:fileError.deleteFailed"],
    ["moveFailed", "dialog:fileError.moveFailed"],
    ["duplicateFailed", "dialog:fileError.duplicateFailed"],
    ["tooManyCopies", "dialog:fileError.tooManyCopies"],
  ] as const)("%s interpolates the name into %s", (fn, key) => {
    expect(FileErrors[fn]("报告 #1.md")).toBe(`<${key}|{"name":"报告 #1.md"}>`);
  });

  it("exportFailed interpolates the format", () => {
    expect(FileErrors.exportFailed("HTML")).toBe('<dialog:fileError.exportFailed|{"format":"HTML"}>');
  });

  it("copyFailed is resolved when read, not frozen at import", () => {
    expect(FileErrors.copyFailed).toBe("<dialog:fileError.copyFailed>");
  });
});
