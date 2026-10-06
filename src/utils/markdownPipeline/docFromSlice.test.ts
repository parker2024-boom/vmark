// @vitest-environment node
// WI-RA2.4 — the one slice-to-markdown path shared by copy and Source Peek.
import { describe, it, expect } from "vitest";
import { Fragment, Slice } from "@tiptap/pm/model";
import { testSchema } from "./testSchema";
import { createDocFromSlice, ensureBlockContent, serializeSlice } from "./docFromSlice";
import { parseMarkdown } from "./adapter";

const paragraph = testSchema.nodes.paragraph;

describe("ensureBlockContent", () => {
  it("gives empty content one empty paragraph", () => {
    const out = ensureBlockContent(Fragment.empty, paragraph);
    expect(out.childCount).toBe(1);
    expect(out.firstChild?.type.name).toBe("paragraph");
    expect(out.firstChild?.content.size).toBe(0);
  });

  it("wraps inline content in a paragraph", () => {
    const out = ensureBlockContent(Fragment.from(testSchema.text("中文 text")), paragraph);
    expect(out.childCount).toBe(1);
    expect(out.firstChild?.textContent).toBe("中文 text");
  });

  it("leaves block content as it is", () => {
    const blocks = Fragment.from(paragraph.create(null, testSchema.text("a")));
    expect(ensureBlockContent(blocks, paragraph)).toBe(blocks);
  });

  it("leaves content alone when the schema has no paragraph", () => {
    expect(ensureBlockContent(Fragment.empty, undefined)).toBe(Fragment.empty);
  });
});

describe("createDocFromSlice", () => {
  it("builds a document from the slice's blocks", () => {
    const doc = parseMarkdown(testSchema, "a\n\nb\n");
    const out = createDocFromSlice(testSchema, doc.slice(0, doc.content.size));
    expect(out.toJSON()).toEqual(doc.toJSON());
  });

  it("keeps content the document node would not hold, rather than refusing it", () => {
    // A bare list item is not a block the document holds directly; the
    // document is built anyway and serialized as far as the converters go.
    const item = testSchema.nodes.listItem.create(null, paragraph.create(null, testSchema.text("x")));
    const out = createDocFromSlice(testSchema, new Slice(Fragment.from(item), 0, 0));
    expect(out.type.name).toBe("doc");
    expect(out.textContent).toBe("x");
  });
});

describe("serializeSlice", () => {
  it("serializes a partial selection inside a paragraph", () => {
    const doc = parseMarkdown(testSchema, "hello *world*\n");
    expect(serializeSlice(testSchema, doc.slice(7, 13))).toBe("*world*\n");
  });

  it("passes the hard-break style through", () => {
    const doc = parseMarkdown(testSchema, "a\\\nb\n");
    const slice = doc.slice(0, doc.content.size);
    expect(serializeSlice(testSchema, slice, { hardBreakStyle: "twoSpaces" })).toBe("a  \nb\n");
    expect(serializeSlice(testSchema, slice, { hardBreakStyle: "backslash" })).toBe("a\\\nb\n");
  });

  it("serializes an empty slice to an empty document", () => {
    expect(serializeSlice(testSchema, Slice.empty)).toBe("");
  });
});
