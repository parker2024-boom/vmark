// @vitest-environment node
// WI-RA11.6 — the tree listing carries the root once and only a name per node;
// every node's absolute path is rebuilt here exactly as the Rust walker spells
// it (`Path::join`), on both separator conventions.
import { describe, expect, it } from "vitest";

import { withAbsolutePaths, type WireTreeListing } from "./treeListingPaths";

function wire(over: Partial<WireTreeListing> = {}): WireTreeListing {
  return { rootPrefix: "/ws/", separator: "/", entries: [], truncated: false, ...over };
}

describe("withAbsolutePaths", () => {
  it("returns an empty tree for an empty listing and keeps the truncation flag", () => {
    expect(withAbsolutePaths(wire({ truncated: true }))).toEqual({ entries: [], truncated: true });
  });

  it("prefixes top-level names with the root and joins nested names with the separator", () => {
    const listing = withAbsolutePaths(
      wire({
        entries: [
          {
            name: "docs",
            isDirectory: true,
            isHidden: false,
            children: [
              { name: "deep", isDirectory: true, isHidden: false, children: [{ name: "c.md", isDirectory: false, isHidden: false }] },
              { name: "a.md", isDirectory: false, isHidden: false },
            ],
          },
          { name: "readme.md", isDirectory: false, isHidden: false },
        ],
      }),
    );

    expect(listing.entries[0].path).toBe("/ws/docs");
    expect(listing.entries[0].children?.[0].path).toBe("/ws/docs/deep");
    expect(listing.entries[0].children?.[0].children?.[0].path).toBe("/ws/docs/deep/c.md");
    expect(listing.entries[0].children?.[1].path).toBe("/ws/docs/a.md");
    expect(listing.entries[1].path).toBe("/ws/readme.md");
  });

  it("spells Windows paths with the backslash the walker joined with", () => {
    const listing = withAbsolutePaths(
      wire({
        rootPrefix: "C:/Users/me/notes\\",
        separator: "\\",
        entries: [
          { name: "sub", isDirectory: true, isHidden: false, children: [{ name: "x.md", isDirectory: false, isHidden: false }] },
        ],
      }),
    );
    expect(listing.entries[0].path).toBe("C:/Users/me/notes\\sub");
    expect(listing.entries[0].children?.[0].path).toBe("C:/Users/me/notes\\sub\\x.md");
  });

  it("uses the prefix verbatim for a filesystem root", () => {
    const listing = withAbsolutePaths(
      wire({ rootPrefix: "/", entries: [{ name: "etc", isDirectory: true, isHidden: false, children: [] }] }),
    );
    expect(listing.entries[0].path).toBe("/etc");
  });

  it("keeps non-ASCII names byte for byte", () => {
    const listing = withAbsolutePaths(
      wire({
        entries: [
          { name: "笔记", isDirectory: true, isHidden: false, children: [{ name: "第一章 🌍.md", isDirectory: false, isHidden: false }] },
        ],
      }),
    );
    expect(listing.entries[0].children?.[0].path).toBe("/ws/笔记/第一章 🌍.md");
  });

  it("carries every other field through unchanged", () => {
    const listing = withAbsolutePaths(
      wire({
        entries: [
          { name: ".locked", isDirectory: true, isHidden: true, unreadable: true, children: [] },
          { name: "pruned", isDirectory: true, isHidden: false, children: [] },
          { name: ".env", isDirectory: false, isHidden: true },
        ],
      }),
    );
    expect(listing.entries).toEqual([
      { name: ".locked", path: "/ws/.locked", isDirectory: true, isHidden: true, unreadable: true, children: [] },
      { name: "pruned", path: "/ws/pruned", isDirectory: true, isHidden: false, children: [] },
      { name: ".env", path: "/ws/.env", isDirectory: false, isHidden: true },
    ]);
  });

  it.each([
    ["no root prefix", { separator: "/", entries: [], truncated: false }],
    ["no separator", { rootPrefix: "/ws/", entries: [], truncated: false }],
    ["entries that are not a list", { rootPrefix: "/ws/", separator: "/", entries: null, truncated: false }],
  ])("rejects a listing with %s", (_name, payload) => {
    expect(() => withAbsolutePaths(payload as unknown as WireTreeListing)).toThrow(/tree listing/);
  });
});
