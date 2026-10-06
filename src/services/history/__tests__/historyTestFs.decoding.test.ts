// @vitest-environment node
// WI-RA22.5 — the history fake's readTextFile decodes like tauri-plugin-fs
// (UTF-8 bytes through `new TextDecoder("utf-8")`, which drops a leading BOM);
// the test-side view keeps every character. See src/test/statefulFsFake.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { pluginFsMock, vfs } from "./historyTestFs";

beforeEach(() => {
  vfs.reset();
});

describe("historyTestFs readTextFile decodes like the plugin", () => {
  it("drops a leading BOM of a seeded file", async () => {
    vfs.seed("/d/a.md", "﻿# Title");
    await expect(pluginFsMock.readTextFile("/d/a.md")).resolves.toBe("# Title");
    expect(vfs.read("/d/a.md")).toBe("﻿# Title");
  });

  it("drops a leading BOM of a file written through writeTextFile", async () => {
    vfs.seed("/d/keep.md", "");
    await pluginFsMock.writeTextFile("/d/b.md", "﻿正文");
    await expect(pluginFsMock.readTextFile("/d/b.md")).resolves.toBe("正文");
  });

  it("keeps a U+FEFF that is not at the start", async () => {
    vfs.seed("/d/c.md", "a﻿b");
    await expect(pluginFsMock.readTextFile("/d/c.md")).resolves.toBe("a﻿b");
  });

  it("replaces a lone surrogate the way UTF-8 encoding does", async () => {
    vfs.seed("/d/e.md", "x\uD800y");
    await expect(pluginFsMock.readTextFile("/d/e.md")).resolves.toBe("x�y");
  });

  it("returns an empty file as empty", async () => {
    vfs.seed("/d/f.md", "");
    await expect(pluginFsMock.readTextFile("/d/f.md")).resolves.toBe("");
  });
});
