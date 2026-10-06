// @vitest-environment node
// WI-RA21.1 — a document's text comes off disk with its byte-order mark.
//
// plugin-fs `readTextFile` decodes with `new TextDecoder("utf-8")`, which drops
// a leading U+FEFF, so a BOM'd file opened as BOM-less and its first save
// stripped the mark. The shared reader decodes the BYTES itself and keeps it.
// UTF-16/UTF-32 files are refused rather than opened as UTF-8 garbage.
// The disk is the stateful fake; its `readFile` returns the seeded bytes.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.fsModule();
});

import { statefulFs } from "@/test/statefulFsFake";
import { ingestExternalText } from "@/utils/editorText";
import {
  decodeDocumentBytes,
  readDocumentText,
  UnsupportedEncodingError,
} from "./readDocumentText";

const PATH = "/repo/doc.md";
const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

function seed(bytes: number[]): void {
  statefulFs.seedBytes(PATH, Uint8Array.from(bytes));
}

beforeEach(() => {
  statefulFs.reset();
});

describe("readDocumentText — UTF-8", () => {
  it("keeps a leading BOM as U+FEFF, which the ingest turns into hasBom", async () => {
    seed([...UTF8_BOM, ...utf8("# 标题\r\n正文\r\n")]);

    const text = await readDocumentText(PATH);

    expect(text).toBe("\u{FEFF}# 标题\r\n正文\r\n");
    const ingest = ingestExternalText(text);
    expect(ingest.hasBom).toBe(true);
    expect(ingest.canonicalEditorText).toBe("# 标题\n正文\n");
    expect(ingest.lineEnding).toBe("crlf");
  });

  it.each([
    ["no BOM", utf8("plain\n"), "plain\n"],
    ["an empty file", [], ""],
    ["a file that is only a BOM", UTF8_BOM, "\u{FEFF}"],
    ["two BOMs — the second is content", [...UTF8_BOM, ...UTF8_BOM, ...utf8("x")], "\u{FEFF}\u{FEFF}x"],
    ["a BOM past offset 0 — content, untouched", utf8("a\u{FEFF}b"), "a\u{FEFF}b"],
    ["lone CR and CRLF — raw, not canonicalised", utf8("a\rb\r\nc"), "a\rb\r\nc"],
    ["CJK and an astral character", utf8("中文 😀\n"), "中文 😀\n"],
  ])("decodes %s exactly", async (_label, bytes, expected) => {
    seed(bytes);
    await expect(readDocumentText(PATH)).resolves.toBe(expected);
  });

  it("decodes invalid UTF-8 lossily, as the plugin did (refusing it is not this reader's call)", () => {
    expect(decodeDocumentBytes(Uint8Array.from([0x61, 0xff, 0x62]), PATH)).toBe("a\u{FFFD}b");
  });

  it("propagates the plugin's error for a missing file", async () => {
    await expect(readDocumentText("/repo/missing.md")).rejects.toThrow(/No such file/);
  });
});

describe("readDocumentText — encodings VMark cannot round-trip", () => {
  it.each([
    ["UTF-16LE", [0xff, 0xfe, 0x23, 0x00, 0x20, 0x00]],
    ["UTF-16BE", [0xfe, 0xff, 0x00, 0x23, 0x00, 0x20]],
    ["UTF-32LE", [0xff, 0xfe, 0x00, 0x00, 0x23, 0x00, 0x00, 0x00]],
    ["UTF-32BE", [0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x23]],
    ["UTF-16LE with nothing after its BOM", [0xff, 0xfe]],
  ])("refuses %s instead of decoding it as UTF-8", async (encoding, bytes) => {
    seed(bytes);

    const error = await readDocumentText(PATH).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UnsupportedEncodingError);
    const refusal = error as UnsupportedEncodingError;
    expect(refusal.encoding).toBe(encoding.split(" ")[0]);
    // The message is the toast detail: it names the file and the encoding.
    expect(refusal.message).toContain(PATH);
    expect(refusal.message).toContain(refusal.encoding);
  });

  it("does not mistake a lone 0xFF or 0xFE byte for a BOM", () => {
    expect(decodeDocumentBytes(Uint8Array.from([0xff]), PATH)).toBe("\u{FFFD}");
    expect(decodeDocumentBytes(Uint8Array.from([0xfe, 0x61]), PATH)).toBe("\u{FFFD}a");
  });
});
