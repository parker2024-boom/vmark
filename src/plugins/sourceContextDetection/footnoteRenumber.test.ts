// WI-RA17A.1 — the pure steps renumberFootnotes is composed of
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseDefinitions, parseReferences } from "./footnoteActions";
import {
  appendConsolidatedDefinitions,
  buildLabelMap,
  needsRenumber,
  relabelReferences,
  removeDefinitionsWithShift,
} from "./footnoteRenumber";

describe("buildLabelMap", () => {
  it("numbers labels by first appearance and ignores repeats", () => {
    const refs = parseReferences("[^b] [^a] [^b] [^c]");
    expect([...buildLabelMap(refs)]).toEqual([
      ["b", "1"],
      ["a", "2"],
      ["c", "3"],
    ]);
  });

  it("is empty for no references", () => {
    expect(buildLabelMap([]).size).toBe(0);
  });
});

describe("needsRenumber", () => {
  const check = (doc: string) =>
    needsRenumber(doc, parseDefinitions(doc), buildLabelMap(parseReferences(doc)));

  it.each([
    ["labels out of order", "A[^2] B[^1]\n\n[^1]: one\n[^2]: two", true],
    ["an orphaned definition", "A[^1]\n\n[^1]: one\n[^9]: orphan", true],
    ["a reference without a definition", "A[^1] B[^2]\n\n[^1]: one", true],
    ["text after the last definition", "A[^1]\n\n[^1]: one\n\nmore", true],
    ["no definitions at all, labels sequential", "A[^1]", true],
    ["sequential labels with trailing definitions", "A[^1] B[^2]\n\n[^1]: one\n[^2]: two", false],
    ["only whitespace after the last definition", "A[^1]\n\n[^1]: one  \n\n", false],
    ["text with no references and no definitions", "Just prose", false],
  ])("reports %s as %s", (_name, doc, expected) => {
    expect(check(doc)).toBe(expected);
  });
});

describe("removeDefinitionsWithShift", () => {
  it("returns the document unchanged when there are no definitions", () => {
    const { text, adjustPosition } = removeDefinitionsWithShift("plain [^1]", []);
    expect(text).toBe("plain [^1]");
    expect(adjustPosition(6)).toBe(6);
  });

  it("keeps one newline after a definition followed by text", () => {
    const doc = "A\n[^1]: one\n\n\nB";
    const { text, adjustPosition } = removeDefinitionsWithShift(doc, parseDefinitions(doc));
    expect(text).toBe("A\n\nB");
    expect(adjustPosition(doc.indexOf("B"))).toBe(text.indexOf("B"));
  });

  it("removes trailing newlines entirely at document end", () => {
    const doc = "A\n[^1]: one\n\n";
    expect(removeDefinitionsWithShift(doc, parseDefinitions(doc)).text).toBe("A\n");
  });

  it("removes definitions separated only by blank lines as one block", () => {
    const doc = "A\n[^1]: one\n\n[^2]: two\n\n\nB [^1]";
    const { text, adjustPosition } = removeDefinitionsWithShift(doc, parseDefinitions(doc));
    expect(text).toBe("A\n\nB [^1]");
    expect(adjustPosition(doc.lastIndexOf("[^1]"))).toBe(text.indexOf("[^1]"));
  });

  it("maps a position inside a removed definition to -1", () => {
    const doc = "[^1]: has [^2] inside\n\nBody";
    const { adjustPosition } = removeDefinitionsWithShift(doc, parseDefinitions(doc));
    expect(adjustPosition(doc.indexOf("[^2]"))).toBe(-1);
  });

  it("leaves a position before every removal unchanged", () => {
    const doc = "Body [^1]\n\n[^1]: one";
    const { adjustPosition } = removeDefinitionsWithShift(doc, parseDefinitions(doc));
    expect(adjustPosition(5)).toBe(5);
  });
});

describe("relabelReferences", () => {
  it("rewrites each reference at its shifted position and skips removed ones", () => {
    const doc = "[^x]: def [^y]\n\nSee [^y] and [^long]";
    const refs = parseReferences(doc);
    const labelMap = buildLabelMap(refs);
    const { text, adjustPosition } = removeDefinitionsWithShift(doc, parseDefinitions(doc));
    expect(relabelReferences(text, refs, labelMap, adjustPosition)).toBe(
      "\nSee [^1] and [^2]",
    );
  });

  it("leaves a reference whose label is already its number", () => {
    const refs = parseReferences("A [^1]");
    expect(relabelReferences("A [^1]", refs, buildLabelMap(refs), (p) => p)).toBe("A [^1]");
  });
});

describe("appendConsolidatedDefinitions", () => {
  it("trims the body and writes definitions in label-map order", () => {
    const labelMap = new Map([
      ["b", "1"],
      ["a", "2"],
    ]);
    const defs = parseDefinitions("[^a]: Alpha\n[^b]: Beta\n    more");
    expect(appendConsolidatedDefinitions("Body \n\n", labelMap, defs)).toBe(
      "Body\n\n[^1]: Beta\n    more\n[^2]: Alpha",
    );
  });

  it("writes an empty placeholder for a label with no definition", () => {
    expect(appendConsolidatedDefinitions("B", new Map([["z", "1"]]), [])).toBe("B\n\n[^1]: ");
  });

  it("uses the last definition when a label is defined twice", () => {
    const defs = parseDefinitions("[^a]: first\n[^a]: second");
    expect(appendConsolidatedDefinitions("B", new Map([["a", "1"]]), defs)).toBe(
      "B\n\n[^1]: second",
    );
  });
});
