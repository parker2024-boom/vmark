// WI-RA1A.6 — the checkpoint a bridge write leaves behind, recorded by one
// helper instead of a copy in each handler. Real mcpStore; the disk append
// goes to the globally mocked Tauri fs.
import { describe, it, expect, beforeEach } from "vitest";
import { useMcpStore } from "@/stores/mcpStore";
import { describeSizeChange, recordBridgeCheckpoint } from "@/services/mcpBridge/v2/checkpoint";

beforeEach(() => {
  useMcpStore.setState((s) => ({
    checkpoint: { ...s.checkpoint, checkpoints: [], hydrated: false },
  }));
});

describe("describeSizeChange", () => {
  it.each([
    { before: "abc", after: "abcdef", expected: "Wrote document (+3 chars, was 3, now 6)" },
    { before: "abcdef", after: "abc", expected: "Wrote document (−3 chars, was 6, now 3)" },
    { before: "same", after: "also", expected: "Wrote document (+0 chars, was 4, now 4)" },
    { before: "", after: "", expected: "Wrote document (+0 chars, was 0, now 0)" },
    { before: "", after: "中文", expected: "Wrote document (+2 chars, was 0, now 2)" },
  ])("$before → $after", ({ before, after, expected }) => {
    expect(describeSizeChange("Wrote document", before, after)).toBe(expected);
  });

  it("leads with the verb it is given", () => {
    expect(describeSizeChange("Replaced selection", "hello", "HELLO!")).toBe(
      "Replaced selection (+1 chars, was 5, now 6)",
    );
  });
});

describe("recordBridgeCheckpoint", () => {
  it("is readable from the store as soon as it returns", () => {
    recordBridgeCheckpoint({
      tabId: "t-1",
      filePath: "/w/notes.md",
      tool: "document.write",
      description: "Wrote document (+1 chars, was 6, now 7)",
      contentBefore: "before",
      revisionBefore: "rev-AAAAAAAA",
      revisionAfter: "rev-BBBBBBBB",
    });

    const [checkpoint] = useMcpStore.getState().checkpointList({ tabId: "t-1" });
    expect(checkpoint).toMatchObject({
      tabId: "t-1",
      filePath: "/w/notes.md",
      tool: "document.write",
      description: "Wrote document (+1 chars, was 6, now 7)",
      contentBefore: "before",
      revisionBefore: "rev-AAAAAAAA",
      revisionAfter: "rev-BBBBBBBB",
      byteSize: "before".length,
    });
  });

  it("keeps an untitled document's checkpoint, keyed by tab", () => {
    recordBridgeCheckpoint({
      tabId: "t-untitled",
      filePath: null,
      tool: "selection.set",
      description: "Replaced selection (+0 chars, was 1, now 1)",
      contentBefore: "",
      revisionBefore: "rev-AAAAAAAA",
      revisionAfter: "rev-BBBBBBBB",
    });

    expect(useMcpStore.getState().checkpointList({ tabId: "t-untitled" })).toHaveLength(1);
    expect(useMcpStore.getState().checkpointList({ filePath: "/w/notes.md" })).toEqual([]);
  });

  it("records each write separately, newest first", () => {
    for (const before of ["one", "two"]) {
      recordBridgeCheckpoint({
        tabId: "t-1",
        filePath: "/w/notes.md",
        tool: "document.transform",
        description: "Transform: cjk-spacing",
        contentBefore: before,
        revisionBefore: "rev-AAAAAAAA",
        revisionAfter: "rev-BBBBBBBB",
      });
    }

    const list = useMcpStore.getState().checkpointList({ tabId: "t-1" });
    expect(list.map((c) => c.contentBefore)).toEqual(["two", "one"]);
  });
});
