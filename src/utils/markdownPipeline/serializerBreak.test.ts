// @vitest-environment node
// WI-RA2.1 — the hard-break style is applied where a `break` node is
// serialized, so nothing that merely looks like a break (math, HTML, a literal
// backslash) is rewritten.
// WI-RA2.2 — a literal trailing backslash before a soft break stays a soft
// break in two-space style.
import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import type { Root } from "mdast";
import type { Node as PMNode } from "@tiptap/pm/model";
import { parseMarkdown, serializeMarkdown } from "./adapter";
import { serializeMdastToMarkdown } from "./serializer";
import { dropBlockFinalBreaks } from "./serializerBlockFinalBreak";
import { getProductionSchema } from "@/test/productionSchema";

const schema = getProductionSchema();
const TWO_SPACES = { hardBreakStyle: "twoSpaces" } as const;
const BACKSLASH = { hardBreakStyle: "backslash" } as const;

const roundTrip = (markdown: string, options = {}): string =>
  serializeMarkdown(schema, parseMarkdown(schema, markdown), options);

/** Number of hard-break nodes anywhere in a document. */
function countHardBreaks(doc: PMNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === "hardBreak") count += 1;
  });
  return count;
}

const text = (value: string) => ({ type: "text" as const, value });
const hardBreak = { type: "break" as const };
const root = (children: unknown[]): Root => ({ type: "root", children }) as Root;
const paragraph = (children: unknown[]) => ({ type: "paragraph", children });

describe("hard-break style — constructs that are not hard breaks", () => {
  it("leaves a LaTeX row separator inside a $$ block alone", () => {
    const source = "$$\na \\\\\nb\n$$\n";
    expect(roundTrip(source, TWO_SPACES)).toBe(source);
  });

  it("leaves a backslash line ending inside an HTML block alone", () => {
    const source = "<div>\na \\\nb\n</div>\n";
    expect(roundTrip(source, TWO_SPACES)).toBe(source);
  });

  it("leaves a backslash line ending inside an inline HTML attribute alone", () => {
    const source = 'x <span title="a\\\nb">y</span>\n';
    expect(roundTrip(source, TWO_SPACES)).toBe(source);
  });

  it("leaves a backslash line ending inside inline math alone", () => {
    const source = "x $a \\\\\nb$ y\n";
    expect(roundTrip(source, TWO_SPACES)).toBe(source);
  });

  it("leaves fenced code alone", () => {
    const source = "```\na \\\nb\n```\n";
    expect(roundTrip(source, TWO_SPACES)).toBe(source);
  });

  it("keeps a literal trailing backslash before a soft break a soft break", () => {
    const source = "C:\\dir\\\\\nnext\n";
    const before = parseMarkdown(schema, source);
    expect(countHardBreaks(before)).toBe(0);

    const output = roundTrip(source, TWO_SPACES);
    const after = parseMarkdown(schema, output);
    expect(countHardBreaks(after)).toBe(0);
    expect(after.textContent).toBe(before.textContent);
  });
});

describe("hard-break style — real hard breaks", () => {
  it.each([
    ["paragraph", "a\\\nb\n", "a  \nb\n"],
    // A mark spanning a break comes back as one wrapper per side: the break is
    // an unmarked atom between two marked text nodes.
    ["emphasis", "*a*\\\n*b*\n", "*a*  \n*b*\n"],
    ["blockquote", "> a\\\n> b\n", "> a  \n> b\n"],
    ["list item", "- a\\\n  b\n", "- a  \n  b\n"],
    ["CJK", "中文\\\n日本語\n", "中文  \n日本語\n"],
  ])("writes a %s break in each style", (_label, backslash, twoSpaces) => {
    expect(roundTrip(backslash, BACKSLASH)).toBe(backslash);
    expect(roundTrip(backslash, TWO_SPACES)).toBe(twoSpaces);
    expect(roundTrip(twoSpaces, BACKSLASH)).toBe(backslash);
    expect(roundTrip(twoSpaces, TWO_SPACES)).toBe(twoSpaces);
  });

  it("defaults to the backslash style", () => {
    expect(roundTrip("a  \nb\n")).toBe("a\\\nb\n");
  });

  it.each([
    ["two-space", TWO_SPACES],
    ["backslash", BACKSLASH],
  ])("keeps a literal backslash before a real break in %s style", (_label, options) => {
    const tree = root([paragraph([text("a\\"), hardBreak, text("b")])]);
    const doc = parseMarkdown(schema, serializeMdastToMarkdown(tree, options));
    expect(countHardBreaks(doc)).toBe(1);
    expect(doc.textContent).toBe("a\\b");
  });

  it.each([
    ["a leading break", [hardBreak, text("b")], 1],
    ["consecutive breaks", [text("a"), hardBreak, hardBreak, text("b")], 2],
    ["three consecutive breaks", [text("a"), hardBreak, hardBreak, hardBreak, text("b")], 3],
  ])("does not turn %s into a blank line in two-space style", (_label, children, expected) => {
    const output = serializeMdastToMarkdown(root([paragraph(children)]), TWO_SPACES);
    const doc = parseMarkdown(schema, output);
    expect(doc.childCount).toBe(1);
    expect(countHardBreaks(doc)).toBe(expected);
  });

  it.each([
    ["a space", "a "],
    ["a tab", "a\t"],
    ["several spaces", "a   "],
  ])("keeps text that ends in %s before a break, in either style", (_label, value) => {
    // Trailing spaces written before a two-space break join its run and are
    // read back as part of the break, so the text would lose them.
    const tree = root([paragraph([text(value), hardBreak, text("b")])]);
    for (const options of [TWO_SPACES, BACKSLASH]) {
      const once = serializeMdastToMarkdown(structuredClone(tree), options);
      const doc = parseMarkdown(schema, once);
      expect(countHardBreaks(doc)).toBe(1);
      expect(serializeMarkdown(schema, doc, options)).toBe(once);
    }
  });

  // A delimiter run with whitespace on both sides cannot form, so the mark's
  // handler writes both neighbours as character references. If the break
  // offers a space as its first character, that space is one of them, and
  // `&#x20;` plus one space is not a hard break.
  describe.each([
    ["emphasis", "emphasis"],
    ["strong", "strong"],
    ["strikethrough", "delete"],
  ])("a break directly after %s", (_label, type) => {
    it.each([
      ["a space", "a "],
      ["punctuation", "a."],
      ["a letter", "a"],
      ["CJK", "中"],
    ])("survives when the marked text ends in %s", (_ending, value) => {
      const tree = root([
        paragraph([{ type, children: [text(value)] }, hardBreak, { type, children: [text("b")] }]),
      ]);
      for (const options of [TWO_SPACES, BACKSLASH]) {
        const once = serializeMdastToMarkdown(structuredClone(tree), options);
        const doc = parseMarkdown(schema, once);
        expect(countHardBreaks(doc)).toBe(1);
        expect(doc.textContent).toBe(`${value}b`);
        // Stable from the document's own form on. The tree above is built by
        // hand; a document never holds whitespace at the edge of a
        // strikethrough (markEdgeWhitespace.ts moves it out), so the first
        // serialization of that one tree is not yet the canonical text.
        const twice = serializeMarkdown(schema, doc, options);
        const again = parseMarkdown(schema, twice);
        expect(countHardBreaks(again)).toBe(1);
        expect(again.textContent).toBe(`${value}b`);
        expect(serializeMarkdown(schema, again, options)).toBe(twice);
        if (type !== "delete") expect(twice).toBe(once);
      }
    });
  });

  it.each([
    ["emphasis", "x *y \\\nz* w\n"],
    ["strong", "x **y \\\nz** w\n"],
    ["strikethrough", "x ~~y \\\nz~~ w\n"],
  ])("keeps a break inside %s that follows a space, from a document", (_label, source) => {
    // The mark spans the break. It comes back as one run per side, and the
    // first run's text ends in the space.
    const before = parseMarkdown(schema, source);
    expect(countHardBreaks(before)).toBe(1);
    for (const options of [TWO_SPACES, BACKSLASH]) {
      const once = serializeMarkdown(schema, before, options);
      const after = parseMarkdown(schema, once);
      expect(countHardBreaks(after)).toBe(1);
      expect(after.textContent).toBe(before.textContent);
      expect(serializeMarkdown(schema, after, options)).toBe(once);
    }
  });

  // Text that is only text because something follows it on its line. Before a
  // two-space break what follows is whitespace, so the text has to escape
  // itself — which it can only do if the break says a space comes next.
  it.each([
    ["an ordered-list marker", "1.\\\nx\n"],
    ["a bullet", "-\\\nx\n"],
    ["a plus", "+\\\nx\n"],
    ["a bullet inside a list item", "- -\\\n  x\n"],
    ["a heading marker", "#\\\nx\n"],
    ["a thematic break look-alike", "\\---\\\nx\n"],
    ["a quote marker", "\\>\\\nx\n"],
  ])("keeps %s before a break as text, in either style", (_label, source) => {
    const before = parseMarkdown(schema, source);
    expect(countHardBreaks(before)).toBe(1);
    for (const options of [TWO_SPACES, BACKSLASH]) {
      const once = serializeMarkdown(schema, before, options);
      const after = parseMarkdown(schema, once);
      expect(after.toJSON()).toEqual(before.toJSON());
      expect(serializeMarkdown(schema, after, options)).toBe(once);
    }
  });

  // mdast-util-to-markdown replaces a line ending that comes directly before
  // an inline `html` node with a space, in case the tag would start an HTML
  // block. For a hard break that leaves `\ ` — a literal backslash — or three
  // spaces, and no break.
  describe("a break directly before inline HTML", () => {
    it.each([
      ["an opening tag", "a\\\n<b>x</b> y\n"],
      ["a closing tag", "a\\\n</b> y\n"],
      ["a tag with attributes", 'a\\\n<span title="t">x</span>\n'],
      ["a tag pair, two-space source", "a  \n<kbd>K</kbd>\n"],
      ["CJK text", "中文\\\n<b>日本語</b>\n"],
      ["inside a blockquote", "> a\\\n> <b>x</b>\n"],
      ["inside a list item", "- a\\\n  <b>x</b>\n"],
    ])("keeps the break before %s, in either style", (_label, source) => {
      const before = parseMarkdown(schema, source);
      expect(countHardBreaks(before)).toBe(1);
      for (const options of [TWO_SPACES, BACKSLASH]) {
        const once = serializeMarkdown(schema, before, options);
        const after = parseMarkdown(schema, once);
        expect(after.toJSON()).toEqual(before.toJSON());
        expect(serializeMarkdown(schema, after, options)).toBe(once);
      }
    });

    it.each([
      ["a block-level tag", "<div>"],
      ["a comment", "<!-- c -->"],
      ["a raw-text tag", "<pre>"],
    ])("drops the break before %s without leaving a backslash", (_label, tag) => {
      // On its own line such a tag starts an HTML block, which ends the
      // paragraph: break-then-tag cannot be written. Only an editor document
      // can hold it; markdown source never parses to it.
      const tree = root([paragraph([text("a"), hardBreak, { type: "html", value: tag }, text("b")])]);
      for (const options of [TWO_SPACES, BACKSLASH]) {
        const once = serializeMdastToMarkdown(structuredClone(tree), options);
        expect(once).toBe(`a ${tag}b\n`);
        const doc = parseMarkdown(schema, once);
        expect(doc.childCount).toBe(1);
        expect(serializeMarkdown(schema, doc, options)).toBe(once);
      }
    });

    // The same replacement hits a SOFT line ending before a tag: the author's
    // line break became a space, and a literal backslash before it was escaped
    // on the first save and not on the second.
    it.each([
      ["a tag pair", "line one\n<b>x</b> two\n"],
      ["a closing tag", "line one\n</b> two\n"],
      ["text ending in a literal backslash", "C:\\dir\\\\\n<b>x</b>\n"],
      ["inside a blockquote", "> line one\n> <b>x</b>\n"],
    ])("keeps a soft line ending before %s", (_label, source) => {
      expect(roundTrip(source, BACKSLASH)).toBe(source);
      expect(roundTrip(source, TWO_SPACES)).toBe(source);
    });

    it("does not change the tree it is given", () => {
      const tree = root([paragraph([text("a"), hardBreak, { type: "html", value: "<b>" }, text("b")])]);
      const copy = structuredClone(tree);
      serializeMdastToMarkdown(tree, TWO_SPACES);
      expect(tree).toEqual(copy);
    });
  });

  // A line that holds one complete tag and then only whitespace starts an
  // HTML block. Two trailing spaces after a tag that begins its line make
  // exactly that line.
  it.each([
    ["a closing tag", "</b>\\\nx\n"],
    ["an opening tag", "<b>\\\nx\n"],
    ["a tag in a blockquote", "> <b>\\\n> x\n"],
    ["a tag in a list item", "- </b>\\\n  x\n"],
    ["a tag after another break", "a\\\n<b>\\\nx\n"],
  ])("keeps a break after %s that begins its line, in either style", (_label, source) => {
    const before = parseMarkdown(schema, source);
    for (const options of [TWO_SPACES, BACKSLASH]) {
      const once = serializeMarkdown(schema, before, options);
      const after = parseMarkdown(schema, once);
      expect(after.toJSON()).toEqual(before.toJSON());
      expect(serializeMarkdown(schema, after, options)).toBe(once);
    }
  });

  it("still writes two spaces after a tag that follows text on its line", () => {
    expect(roundTrip("a <b>x</b>\\\ny\n", TWO_SPACES)).toBe("a <b>x</b>  \ny\n");
  });

  it("is stable for a paragraph line that only looks like a table header", () => {
    // `| h | \` has two cells against a one-cell delimiter row, so this is a
    // paragraph whose first line ends in a hard break.
    const source = "| h | \\\n| - |\n| alpha |\n";
    for (const options of [TWO_SPACES, BACKSLASH]) {
      const once = roundTrip(source, options);
      expect(roundTrip(once, options)).toBe(once);
      expect(parseMarkdown(schema, once).firstChild?.type.name).toBe("paragraph");
    }
  });

  it("writes a break in a table cell as a space, never a line ending", () => {
    const cell = (children: unknown[]) => ({ type: "tableCell", children });
    const row = (cells: unknown[]) => ({ type: "tableRow", children: cells });
    const tree = root([
      {
        type: "table",
        align: [null],
        children: [
          row([cell([text("h")])]),
          row([cell([text("a"), hardBreak, text("b")])]),
          row([cell([text("a "), hardBreak, text("b")])]),
        ],
      },
    ]);
    for (const options of [TWO_SPACES, BACKSLASH]) {
      expect(serializeMdastToMarkdown(tree, options)).toBe(
        "| h   |\n| --- |\n| a b |\n| a b |\n",
      );
    }
  });

  it("is stable on a second round trip in both styles", () => {
    const source = "a\\\nb\n\n$$\nx \\\\\ny\n$$\n\n> c  \n> d\n";
    for (const options of [TWO_SPACES, BACKSLASH]) {
      const once = roundTrip(source, options);
      expect(roundTrip(once, options)).toBe(once);
    }
  });
});

// WI-RA2.3 — a hard break at the end of its block. Markdown has no way to
// write one: a backslash there is a literal backslash, and trailing spaces are
// dropped. The editor can hold one (Shift+Enter at the end of a paragraph).
describe("a hard break at the end of its block", () => {
  const pmBreak = () => schema.nodes.hardBreak.create();
  const pmDoc = (...blocks: PMNode[]) => schema.topNodeType.create(null, blocks);
  const pmParagraph = (...inline: PMNode[]) => schema.nodes.paragraph.create(null, inline);

  it.each([
    ["one break", () => [schema.text("foo"), pmBreak()], "foo\n"],
    ["two breaks", () => [schema.text("foo"), pmBreak(), pmBreak()], "foo\n"],
    ["a break after a break in the text", () => [schema.text("a"), pmBreak(), schema.text("b"), pmBreak()], null],
    ["CJK text", () => [schema.text("中文"), pmBreak()], "中文\n"],
    ["text ending in a backslash", () => [schema.text("C:\\dir\\"), pmBreak()], null],
  ])("adds nothing to the text for %s, in either style", (_label, inline, expected) => {
    const doc = pmDoc(pmParagraph(...inline()), pmParagraph(schema.text("next")));
    const textBefore = doc.firstChild?.textContent;
    for (const options of [TWO_SPACES, BACKSLASH]) {
      const once = serializeMarkdown(schema, doc, options);
      if (expected !== null) expect(once).toBe(`${expected}\nnext\n`);
      const after = parseMarkdown(schema, once);
      expect(after.childCount).toBe(2);
      expect(after.firstChild?.textContent).toBe(textBefore);
      expect(serializeMarkdown(schema, after, options)).toBe(once);
    }
  });

  it("keeps the breaks that are not at the end", () => {
    const doc = pmDoc(pmParagraph(schema.text("a"), pmBreak(), schema.text("b"), pmBreak()));
    for (const options of [TWO_SPACES, BACKSLASH]) {
      expect(countHardBreaks(parseMarkdown(schema, serializeMarkdown(schema, doc, options)))).toBe(1);
    }
  });

  it("adds nothing to a heading that ends in a break", () => {
    const heading = schema.nodes.heading.create({ level: 2 }, [schema.text("Title"), pmBreak()]);
    for (const options of [TWO_SPACES, BACKSLASH]) {
      const once = serializeMarkdown(schema, pmDoc(heading), options);
      expect(once).toBe("## Title\n");
    }
  });

  it("leaves a break that ends a mark in the middle of a paragraph", () => {
    // Not at the end of its block: only the block's own trailing breaks go.
    const tree = root([
      paragraph([{ type: "emphasis", children: [text("a"), hardBreak] }, text("b")]),
    ]);
    expect(dropBlockFinalBreaks(tree)).toBe(tree);
  });

  it("does not change the tree it is given", () => {
    const tree = root([paragraph([text("a"), hardBreak]), paragraph([text("b")])]);
    const copy = structuredClone(tree);
    expect(serializeMdastToMarkdown(tree, BACKSLASH)).toBe("a\n\nb\n");
    expect(tree).toEqual(copy);
  });

  it("writes a paragraph that holds only a break as an empty paragraph would be", () => {
    const empty = serializeMarkdown(schema, pmDoc(pmParagraph(), pmParagraph(schema.text("x"))), BACKSLASH);
    for (const options of [TWO_SPACES, BACKSLASH]) {
      const onlyBreak = pmDoc(pmParagraph(pmBreak()), pmParagraph(schema.text("x")));
      expect(serializeMarkdown(schema, onlyBreak, options)).toBe(empty);
    }
  });
});

describe("hard-break style — agreement with stock remark-stringify", () => {
  // The handler replaces upstream's, so its "is a line ending allowed here"
  // answer must not drift from upstream's. In backslash style the two must
  // produce the same text for every construct a break can sit in.
  const stock = unified().use(remarkStringify, { bullet: "-", emphasis: "*" }).use(remarkGfm);

  const cell = (children: unknown[]) => ({ type: "tableCell", children });
  const row = (cells: unknown[]) => ({ type: "tableRow", children: cells });
  const inline = [text("a"), hardBreak, text("b")];
  const cases: Array<[string, Root]> = [
    ["paragraph", root([paragraph(inline)])],
    ["heading", root([{ type: "heading", depth: 2, children: inline }])],
    ["emphasis", root([paragraph([{ type: "emphasis", children: inline }])])],
    ["strong", root([paragraph([{ type: "strong", children: inline }])])],
    ["delete", root([paragraph([{ type: "delete", children: inline }])])],
    ["blockquote", root([{ type: "blockquote", children: [paragraph(inline)] }])],
    [
      "list item",
      root([
        {
          type: "list",
          ordered: false,
          spread: false,
          children: [{ type: "listItem", spread: false, children: [paragraph(inline)] }],
        },
      ]),
    ],
    [
      "table cell",
      root([
        {
          type: "table",
          align: [null],
          children: [row([cell([text("h")])]), row([cell(inline)])],
        },
      ]),
    ],
    ["leading break", root([paragraph([hardBreak, text("b")])])],
    ["consecutive breaks", root([paragraph([text("a"), hardBreak, hardBreak, text("b")])])],
  ];

  it.each(cases)("matches upstream for a break in a %s", (_label, tree) => {
    expect(serializeMdastToMarkdown(structuredClone(tree), BACKSLASH)).toBe(
      stock.stringify(structuredClone(tree)),
    );
  });
});
