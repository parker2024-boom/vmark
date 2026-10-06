// @vitest-environment node
// WI-RA9A.2 — the single home-expansion and existence check both editors use.
import { describe, expect, it, vi } from "vitest";
import { exists } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { expandHomePath, validateLocalPath } from "./localImagePath";

describe("expandHomePath", () => {
  it.each([
    ["an absolute path", "/absolute/path/file.md"],
    ["a relative path", "relative/path/file.md"],
    ["an empty string", ""],
    ["a bare tilde", "~"],
    ["another user's home", "~other/file.png"],
    ["a tilde that is not leading", "/tmp/~/file.png"],
  ])("returns %s unchanged", async (_label, path) => {
    expect(await expandHomePath(path)).toBe(path);
    expect(homeDir).not.toHaveBeenCalled();
  });

  it.each([
    ["~/Documents/file.md", "/Users/test/Documents/file.md"],
    ["~/图片/截图 1.png", "/Users/test/图片/截图 1.png"],
    ["~/", "/Users/test"],
  ])("expands %s against the home directory", async (path, expected) => {
    expect(await expandHomePath(path)).toBe(expected);
  });

  it("returns null when the home directory cannot be resolved", async () => {
    vi.mocked(homeDir).mockRejectedValueOnce(new Error("no home"));
    expect(await expandHomePath("~/some/file.md")).toBeNull();
  });
});

describe("validateLocalPath", () => {
  it("is false for a path that does not exist", async () => {
    vi.mocked(exists).mockResolvedValueOnce(false);
    expect(await validateLocalPath("/nonexistent/path/file.txt")).toBe(false);
  });

  it("is false, not a rejection, when the check itself fails", async () => {
    vi.mocked(exists).mockRejectedValueOnce(new Error("fs error"));
    expect(await validateLocalPath("/bad/path")).toBe(false);
  });

  it("is true for a path that exists, and asks about exactly that path", async () => {
    vi.mocked(exists).mockResolvedValueOnce(true);
    expect(await validateLocalPath("/valid/文件.png")).toBe(true);
    expect(exists).toHaveBeenLastCalledWith("/valid/文件.png");
  });
});
