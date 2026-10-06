// @vitest-environment node
// WI-RA10B.10 — the App chunk main.tsx awaits is modulepreloaded from
// index.html, with the static imports the entry does not already preload.
import { describe, it, expect } from "vitest";
import { bootChunkPreloads } from "../vite.config.ts";

const chunk = (fileName: string, imports: string[] = [], extra: Record<string, unknown> = {}) => ({
  type: "chunk" as const,
  fileName,
  imports,
  facadeModuleId: null,
  ...extra,
});

/** entry → vendor-react; App → vendor-react, vendor-tiptap → vendor-markdown. */
function bundle() {
  return {
    "entry.js": chunk("assets/entry-1.js", ["assets/vendor-react-1.js"], {
      isEntry: true,
      facadeModuleId: "/repo/index.html",
    }),
    "vendor-react.js": chunk("assets/vendor-react-1.js"),
    "App.js": chunk("assets/App-1.js", ["assets/vendor-react-1.js", "assets/vendor-tiptap-1.js"], {
      facadeModuleId: "/repo/src/App.tsx",
    }),
    "vendor-tiptap.js": chunk("assets/vendor-tiptap-1.js", ["assets/vendor-markdown-1.js"]),
    "vendor-markdown.js": chunk("assets/vendor-markdown-1.js"),
    "Settings.js": chunk("assets/SettingsPage-1.js", [], { facadeModuleId: "/repo/src/pages/Settings.tsx" }),
    "style.css": { type: "asset" as const, fileName: "assets/index-1.css" },
  };
}

describe("bootChunkPreloads", () => {
  it("preloads the App chunk and its static closure, App first", () => {
    expect(bootChunkPreloads(bundle())).toEqual([
      "assets/App-1.js",
      "assets/vendor-tiptap-1.js",
      "assets/vendor-markdown-1.js",
    ]);
  });

  it("leaves out what the entry already preloads, and lazy chunks App does not import", () => {
    const files = bootChunkPreloads(bundle());
    expect(files).not.toContain("assets/vendor-react-1.js");
    expect(files).not.toContain("assets/entry-1.js");
    expect(files).not.toContain("assets/SettingsPage-1.js");
  });

  it("survives an import cycle", () => {
    const b = bundle();
    b["vendor-markdown.js"] = chunk("assets/vendor-markdown-1.js", ["assets/vendor-tiptap-1.js"]);
    expect(bootChunkPreloads(b)).toHaveLength(3);
  });

  it("ignores an import naming a file that is not a chunk of this bundle", () => {
    const b = bundle();
    b["vendor-markdown.js"] = chunk("assets/vendor-markdown-1.js", ["assets/missing.js"]);
    expect(bootChunkPreloads(b)).not.toContain("assets/missing.js");
  });

  it("fails the build when no chunk is built from the boot module", () => {
    const { "App.js": _app, ...withoutApp } = bundle();
    expect(() => bootChunkPreloads(withoutApp)).toThrow(/no chunk is built from \/src\/App\.tsx/);
  });
});
