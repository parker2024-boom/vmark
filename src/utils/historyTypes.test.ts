/**
 * Tests for historyTypes.ts — pure helpers and constants for document history.
 *
 * Covers: parseHistoryIndex, generatePreview, getDocumentName, getByteSize,
 * buildHistorySettings, hashPath, emitHistoryCleared, and constants.
 */

import { describe, it, expect, vi } from "vitest";
import {
  HISTORY_FOLDER,
  INDEX_FILE,
  PREVIEW_LENGTH,
  HISTORY_CLEARED_EVENT,
  emitHistoryCleared,
  parseHistoryIndex,
  generatePreview,
  getDocumentName,
  createHistoryIndex,
  getByteSize,
  buildHistorySettings,
  hashPath,
} from "./historyTypes";

// ---- Constants ----

describe("history constants", () => {
  it("HISTORY_FOLDER is 'history'", () => {
    expect(HISTORY_FOLDER).toBe("history");
  });

  it("INDEX_FILE is 'index.json'", () => {
    expect(INDEX_FILE).toBe("index.json");
  });

  it("PREVIEW_LENGTH is 200", () => {
    expect(PREVIEW_LENGTH).toBe(200);
  });

  it("HISTORY_CLEARED_EVENT is 'vmark:history-cleared'", () => {
    expect(HISTORY_CLEARED_EVENT).toBe("vmark:history-cleared");
  });
});

// ---- emitHistoryCleared ----

describe("emitHistoryCleared", () => {
  it("dispatches a CustomEvent on window", () => {
    const listener = vi.fn();
    window.addEventListener(HISTORY_CLEARED_EVENT, listener);

    emitHistoryCleared();

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect(event.type).toBe(HISTORY_CLEARED_EVENT);

    window.removeEventListener(HISTORY_CLEARED_EVENT, listener);
  });
});

// ---- parseHistoryIndex ----

describe("parseHistoryIndex", () => {
  it("returns valid HistoryIndex for correct input", () => {
    const raw = {
      pathHash: "abc123",
      documentPath: "/test.md",
      documentName: "test.md",
      status: "active",
      deletedAt: null,
      snapshots: [],
      settings: { maxSnapshots: 50, maxAgeDays: 30, mergeWindowSeconds: 0, maxFileSizeKB: 0 },
    };
    const result = parseHistoryIndex(raw);
    expect(result).not.toBeNull();
    expect(result!.pathHash).toBe("abc123");
  });

  it("returns null for null input", () => {
    expect(parseHistoryIndex(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseHistoryIndex(undefined)).toBeNull();
  });

  it("returns null for non-object input (string)", () => {
    expect(parseHistoryIndex("not an object")).toBeNull();
  });

  it("returns null for non-object input (number)", () => {
    expect(parseHistoryIndex(42)).toBeNull();
  });

  it("returns null for non-object input (boolean)", () => {
    expect(parseHistoryIndex(true)).toBeNull();
  });

  it("returns null for array input", () => {
    expect(parseHistoryIndex([1, 2, 3])).toBeNull();
  });

  it("returns null when pathHash is missing", () => {
    expect(parseHistoryIndex({ snapshots: [] })).toBeNull();
  });

  it("returns null when pathHash is not a string", () => {
    expect(parseHistoryIndex({ pathHash: 123, snapshots: [] })).toBeNull();
  });

  it("returns null when snapshots is missing", () => {
    expect(parseHistoryIndex({ pathHash: "abc" })).toBeNull();
  });

  it("returns null when snapshots is not an array", () => {
    expect(parseHistoryIndex({ pathHash: "abc", snapshots: "not-array" })).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(parseHistoryIndex({})).toBeNull();
  });

  it("accepts object with extra properties", () => {
    const raw = { pathHash: "abc", snapshots: [], extra: "ignored" };
    expect(parseHistoryIndex(raw)).not.toBeNull();
  });
});

// ---- generatePreview ----

describe("generatePreview", () => {
  it("returns first PREVIEW_LENGTH characters", () => {
    const content = "a".repeat(300);
    const preview = generatePreview(content);
    expect(preview.length).toBe(PREVIEW_LENGTH);
  });

  it("replaces newlines with spaces", () => {
    const content = "line1\nline2\nline3";
    expect(generatePreview(content)).toBe("line1 line2 line3");
  });

  it("trims whitespace", () => {
    const content = "  hello  ";
    expect(generatePreview(content)).toBe("hello");
  });

  it("handles empty string", () => {
    expect(generatePreview("")).toBe("");
  });

  it("handles content shorter than PREVIEW_LENGTH", () => {
    expect(generatePreview("short")).toBe("short");
  });

  it("handles content with only newlines", () => {
    expect(generatePreview("\n\n\n")).toBe("");
  });

  it("handles CJK content", () => {
    const cjk = "\u4f60\u597d\u4e16\u754c";
    expect(generatePreview(cjk)).toBe(cjk);
  });

  it("handles mixed newlines and content", () => {
    const content = "\n\nHello\n\nWorld\n\n";
    expect(generatePreview(content)).toBe("Hello  World");
  });

  it("truncates at PREVIEW_LENGTH before replacing newlines", () => {
    // Build content: 100 chars + newline + 100 chars + ... (over 200)
    const content = "a".repeat(100) + "\n" + "b".repeat(150);
    const preview = generatePreview(content);
    // Slice happens first (200 chars), then \n -> space
    expect(preview.length).toBe(PREVIEW_LENGTH);
  });

  // WI-RA10A.12 — the preview is cut on a character boundary.
  it("drops an emoji that straddles PREVIEW_LENGTH instead of halving it", () => {
    const preview = generatePreview(`${"a".repeat(PREVIEW_LENGTH - 1)}\u{1F600}tail`);
    expect(preview).toBe("a".repeat(PREVIEW_LENGTH - 1));
  });

  it("is well-formed when the limit falls inside a surrogate pair", () => {
    // One leading unit puts every two-unit character on an odd offset, so the
    // even limit lands between the halves of one of them.
    const preview = generatePreview(`a${"\u{20BB7}".repeat(PREVIEW_LENGTH)}`);
    expect(preview).toBe(`a${"\u{20BB7}".repeat(PREVIEW_LENGTH / 2 - 1)}`);
    expect(preview).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it("does not separate a combining accent from its letter at the limit", () => {
    const preview = generatePreview(`${"a".repeat(PREVIEW_LENGTH - 1)}é`);
    expect(preview).toBe("a".repeat(PREVIEW_LENGTH - 1));
  });
});

// ---- getDocumentName ----

describe("getDocumentName", () => {
  // WI-RA26.6 — the name for a path with no file name is the caller's
  // translated "Untitled": utils are leaf-pure and cannot reach i18n.
  const UNTITLED = "未命名";

  it("extracts filename from path", () => {
    expect(getDocumentName("/Users/test/docs/notes.md", UNTITLED)).toBe("notes.md");
  });

  it("returns the caller's untitled name for an empty path", () => {
    expect(getDocumentName("", UNTITLED)).toBe(UNTITLED);
  });

  it("handles Windows-style paths", () => {
    // getFileName uses the last / segment
    expect(getDocumentName("C:/Users/test/doc.md", UNTITLED)).toBe("doc.md");
  });

  it("handles path with only filename", () => {
    expect(getDocumentName("readme.md", UNTITLED)).toBe("readme.md");
  });

  it("handles CJK filenames", () => {
    expect(getDocumentName("/docs/\u7b14\u8bb0.md", UNTITLED)).toBe("\u7b14\u8bb0.md");
  });

  it("returns the caller's untitled name for a path ending with a slash", () => {
    // getFileName returns empty string for trailing slash
    expect(getDocumentName("/docs/folder/", UNTITLED)).toBe(UNTITLED);
  });

  it("never falls back to hard-coded English", () => {
    expect(getDocumentName("", "Sans titre")).toBe("Sans titre");
  });
});

// ---- createHistoryIndex ----

describe("createHistoryIndex", () => {
  const settings = { maxSnapshots: 50, maxAgeDays: 7, mergeWindowSeconds: 30, maxFileSizeKB: 512 };

  it("builds an empty, active index named after the file", () => {
    expect(createHistoryIndex("/docs/notes.md", "abc", settings, "\u672a\u547d\u540d")).toEqual({
      documentPath: "/docs/notes.md",
      documentName: "notes.md",
      pathHash: "abc",
      status: "active",
      deletedAt: null,
      snapshots: [],
      settings,
    });
  });

  // WI-RA26.6 — the caller's translated name, never hard-coded English.
  it("names a path with no file name with the caller's untitled name", () => {
    expect(createHistoryIndex("/docs/", "abc", settings, "\u672a\u547d\u540d").documentName).toBe(
      "\u672a\u547d\u540d",
    );
  });
});

// ---- getByteSize ----

describe("getByteSize", () => {
  it("returns correct byte size for ASCII", () => {
    expect(getByteSize("hello")).toBe(5);
  });

  it("returns correct byte size for empty string", () => {
    expect(getByteSize("")).toBe(0);
  });

  it("returns correct byte size for CJK (3 bytes per char)", () => {
    // Each CJK character is 3 bytes in UTF-8
    expect(getByteSize("\u4f60\u597d")).toBe(6);
  });

  it("returns correct byte size for emoji (4 bytes)", () => {
    // Most emoji are 4 bytes in UTF-8
    const size = getByteSize("\u{1F600}");
    expect(size).toBe(4);
  });

  it("handles mixed ASCII and CJK", () => {
    // "hi" = 2 bytes, "\u4f60\u597d" = 6 bytes
    expect(getByteSize("hi\u4f60\u597d")).toBe(8);
  });

  it("handles Latin extended characters (2 bytes)", () => {
    // e.g., "\u00e9" (e with accent) is 2 bytes in UTF-8
    expect(getByteSize("\u00e9")).toBe(2);
  });

  it("handles newlines", () => {
    expect(getByteSize("\n")).toBe(1);
    expect(getByteSize("a\nb")).toBe(3);
  });
});

// ---- buildHistorySettings ----

describe("buildHistorySettings", () => {
  it("maps general settings to HistorySettings", () => {
    const result = buildHistorySettings({
      historyMaxSnapshots: 100,
      historyMaxAgeDays: 60,
      historyMergeWindow: 30,
      historyMaxFileSize: 512,
    });

    expect(result).toEqual({
      maxSnapshots: 100,
      maxAgeDays: 60,
      mergeWindowSeconds: 30,
      maxFileSizeKB: 512,
    });
  });

  it("handles zero values", () => {
    const result = buildHistorySettings({
      historyMaxSnapshots: 0,
      historyMaxAgeDays: 0,
      historyMergeWindow: 0,
      historyMaxFileSize: 0,
    });

    expect(result.maxSnapshots).toBe(0);
    expect(result.maxAgeDays).toBe(0);
    expect(result.mergeWindowSeconds).toBe(0);
    expect(result.maxFileSizeKB).toBe(0);
  });

  it("handles large values", () => {
    const result = buildHistorySettings({
      historyMaxSnapshots: 999999,
      historyMaxAgeDays: 365,
      historyMergeWindow: 3600,
      historyMaxFileSize: 102400,
    });

    expect(result.maxSnapshots).toBe(999999);
    expect(result.maxAgeDays).toBe(365);
  });
});

// ---- hashPath ----

describe("hashPath", () => {
  it("returns a 16-character hex string", async () => {
    const hash = await hashPath("/Users/test/doc.md");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces consistent hashes for same input", async () => {
    const hash1 = await hashPath("/Users/test/doc.md");
    const hash2 = await hashPath("/Users/test/doc.md");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", async () => {
    const hash1 = await hashPath("/doc1.md");
    const hash2 = await hashPath("/doc2.md");
    expect(hash1).not.toBe(hash2);
  });

  it("handles empty string", async () => {
    const hash = await hashPath("");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles CJK path", async () => {
    const hash = await hashPath("/\u6587\u6863/\u7b14\u8bb0.md");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles very long paths", async () => {
    const longPath = "/" + "a".repeat(10000) + ".md";
    const hash = await hashPath(longPath);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles path with special characters", async () => {
    const hash = await hashPath("/path with spaces/doc (1).md");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles Unicode emoji in path", async () => {
    const hash = await hashPath("/\u{1F4C1}/doc.md");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
