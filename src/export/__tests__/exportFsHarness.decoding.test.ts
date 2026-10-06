// @vitest-environment node
// WI-RA22.5 — the export fake's readTextFile decodes like tauri-plugin-fs
// (UTF-8 bytes through `new TextDecoder("utf-8")`, which drops a leading BOM);
// `files` keeps every character. See src/test/statefulFsFake.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { createFsMock, dirs, files, resetFs } from "./exportFsHarness";

const fs = createFsMock();

beforeEach(() => {
  resetFs();
});

describe("exportFsHarness readTextFile decodes like the plugin", () => {
  it("drops a leading BOM of a file written through writeTextFile", async () => {
    await fs.writeTextFile("/users/me/a.html", "﻿<p>文</p>");
    await expect(fs.readTextFile("/users/me/a.html")).resolves.toBe("<p>文</p>");
    expect(files.get("/users/me/a.html")).toBe("﻿<p>文</p>");
  });

  it("keeps a U+FEFF that is not at the start", async () => {
    files.set("/users/me/b.html", "a﻿b");
    await expect(fs.readTextFile("/users/me/b.html")).resolves.toBe("a﻿b");
  });

  it("replaces a lone surrogate the way UTF-8 encoding does", async () => {
    files.set("/users/me/c.html", "x\uDC00y");
    await expect(fs.readTextFile("/users/me/c.html")).resolves.toBe("x�y");
  });

  it("still rejects a missing file", async () => {
    expect(dirs.has("/users/me")).toBe(true);
    await expect(fs.readTextFile("/users/me/none.html")).rejects.toThrow("ENOENT");
  });
});
