// @vitest-environment node
// WI-RA21.2 — the stateful fs fake decodes files the way tauri-plugin-fs does.
//
// The fake used to hand `readTextFile` callers a file's leading U+FEFF, which
// the real plugin drops; every jsdom BOM test passed on that difference while
// the app lost the mark on save. These cases pin the plugin's behaviour as read
// from its source (see the header of statefulFsFake.ts): files are bytes,
// `readFile` returns them untouched, `readTextFile` is
// `new TextDecoder("utf-8").decode(bytes)`, and `writeTextFile` encodes with
// `TextEncoder`.
import { beforeEach, describe, expect, it } from "vitest";
import { statefulFs } from "./statefulFsFake";

interface PluginFs {
  readFile: (path: string) => Promise<Uint8Array>;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
}

const fs = () => statefulFs.fsModule() as unknown as PluginFs;
const PATH = "/repo/doc.md";
const BOM = [0xef, 0xbb, 0xbf];
const utf8 = (text: string) => [...new TextEncoder().encode(text)];
const seed = (bytes: number[]) => statefulFs.seedBytes(PATH, Uint8Array.from(bytes));

beforeEach(() => {
  statefulFs.reset();
  statefulFs.mkdirp("/repo");
});

describe("readTextFile decodes like the plugin", () => {
  it("drops a leading BOM, which readFile and the test-side read keep", async () => {
    seed([...BOM, ...utf8("# 标题\r\n")]);

    await expect(fs().readTextFile(PATH)).resolves.toBe("# 标题\r\n");
    expect([...(await fs().readFile(PATH))]).toEqual([...BOM, ...utf8("# 标题\r\n")]);
    expect(statefulFs.read(PATH)).toBe("\u{FEFF}# 标题\r\n");
  });

  it("drops only the first of two BOMs, and none that is not at offset 0", async () => {
    seed([...BOM, ...BOM, ...utf8("x")]);
    await expect(fs().readTextFile(PATH)).resolves.toBe("\u{FEFF}x");

    seed(utf8("a\u{FEFF}b"));
    await expect(fs().readTextFile(PATH)).resolves.toBe("a\u{FEFF}b");
  });

  it("replaces invalid UTF-8 with U+FFFD rather than failing", async () => {
    seed([0x61, 0xff, 0x62]);
    await expect(fs().readTextFile(PATH)).resolves.toBe("a\u{FFFD}b");
  });

  it("turns a UTF-16 file into replacement characters and NULs (why documents refuse it)", async () => {
    seed([0xff, 0xfe, 0x23, 0x00]);
    await expect(fs().readTextFile(PATH)).resolves.toBe("\u{FFFD}\u{FFFD}#\u0000");
    expect([...(await fs().readFile(PATH))]).toEqual([0xff, 0xfe, 0x23, 0x00]);
  });

  it("an empty file is empty both ways", async () => {
    seed([]);
    await expect(fs().readTextFile(PATH)).resolves.toBe("");
    expect([...(await fs().readFile(PATH))]).toEqual([]);
  });
});

describe("writeTextFile encodes like the plugin", () => {
  it("writes a leading U+FEFF as the EF BB BF mark", async () => {
    await fs().writeTextFile(PATH, "\u{FEFF}body");

    expect([...(await fs().readFile(PATH))]).toEqual([...BOM, ...utf8("body")]);
    await expect(fs().readTextFile(PATH)).resolves.toBe("body");
  });

  it("a returned byte array is a copy: mutating it does not change the file", async () => {
    seed(utf8("abc"));
    const bytes = await fs().readFile(PATH);
    bytes[0] = 0x7a;
    expect(statefulFs.read(PATH)).toBe("abc");
  });
});
