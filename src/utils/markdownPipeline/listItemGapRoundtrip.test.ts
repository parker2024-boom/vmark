// @vitest-environment node
// WI-RA26.2 — a loose list round-trips with the item gaps the author wrote.
//
// CommonMark makes a whole list loose when any two of its items are separated
// by a blank line. Saving wrote such a list with a blank line between EVERY
// pair of items (fidelity corpus 02-lists.md and 19-list-edge-cases.md), so
// opening a file and typing one character rewrote its lists. Each item now
// remembers whether the source had a blank line before it, and the serializer
// keeps that spelling while the list stays loose.
import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { getProductionSchema } from "@/test/productionSchema";
import { parseMarkdown, serializeMarkdown } from "./adapter";

const schema = getProductionSchema();
const roundTrip = (md: string): string => serializeMarkdown(schema, parseMarkdown(schema, md));

/** The `spread` of every list in the document, in document order. */
function spreads(doc: PMNode): boolean[] {
  const out: boolean[] = [];
  doc.descendants((node) => {
    if (node.type.name === "bulletList" || node.type.name === "orderedList") {
      out.push(node.attrs.spread === true);
    }
  });
  return out;
}

describe("a loose list keeps its authored item gaps", () => {
  it.each([
    { name: "one blank gap in an ordered list", md: "1. a\n2. b\n3. c\n\n4. d\n5. e\n" },
    { name: "the blank gap first", md: "- a\n\n- b\n- c\n" },
    { name: "a task list joined to a bullet list by one gap", md: "- [ ] t\n- [x] u\n\n- v\n  - nested\n    - deeper\n" },
    { name: "every gap blank (unchanged)", md: "- a\n\n- b\n\n- c\n" },
    { name: "loose only through an item holding two blocks", md: "- a\n- b\n\n  more\n- c\n" },
    { name: "a nested loose list inside a tight one", md: "- a\n  - x\n\n  - y\n  - z\n- b\n" },
    { name: "CJK items", md: "1. 中文\n2. 日本語\n\n3. 한국어\n" },
    { name: "a tight list (unchanged)", md: "- a\n- b\n- c\n" },
  ])("$name round-trips byte-identical", ({ md }) => {
    expect(roundTrip(md)).toBe(md);
  });

  it("reads CRLF line endings the same way", () => {
    expect(roundTrip("1. a\r\n2. b\r\n\r\n3. c\r\n").replace(/\r\n/g, "\n")).toBe(
      "1. a\n2. b\n\n3. c\n",
    );
  });

  it("is stable: a second round trip changes nothing", () => {
    const once = roundTrip("- a\n- b\n\n- c\n- d\n");
    expect(roundTrip(once)).toBe(once);
  });

  it("collapses a longer run between items to the one blank line looseness needs", () => {
    // Runs of blank lines are the opt-in blank-line preservation's business;
    // inside a list only "blank or not" is kept.
    expect(roundTrip("- a\n\n\n- b\n- c\n")).toBe("- a\n\n- b\n- c\n");
  });
});

describe("an edit cannot turn a loose list tight", () => {
  it("removing the only item that had a blank line before it keeps the list loose", () => {
    const doc = parseMarkdown(schema, "- a\n- b\n\n- c\n- d\n");
    const list = doc.child(0);
    // Drop item "c" — the one item the source separated with a blank line.
    const items: PMNode[] = [];
    list.forEach((item, _offset, index) => {
      if (index !== 2) items.push(item);
    });
    const edited = schema.nodes.doc.create(null, [list.type.create(list.attrs, items)]);

    const markdown = serializeMarkdown(schema, edited);

    expect(spreads(parseMarkdown(schema, markdown))).toEqual([true]);
    expect(markdown).toBe("- a\n\n- b\n\n- d\n");
  });

  it("an item built without the marker is written with the list's blank line", () => {
    const doc = parseMarkdown(schema, "1. a\n2. b\n\n3. c\n");
    const list = doc.child(0);
    const fresh = schema.nodes.listItem.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("new")]),
    ]);
    const items: PMNode[] = [];
    list.forEach((item) => items.push(item));
    items.push(fresh);
    const edited = schema.nodes.doc.create(null, [list.type.create(list.attrs, items)]);

    expect(serializeMarkdown(schema, edited)).toBe("1. a\n2. b\n\n3. c\n\n4. new\n");
  });
});
