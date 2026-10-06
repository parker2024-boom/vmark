// @vitest-environment node
// WI-RA2.3 — escaped custom markers (`\==`, `\++`, `\^`, `\~`): an escape works
// wherever the parser reads text, whatever precedes it in the document, and
// the placeholder that stands in for it during the parse never reaches a node.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Node as PMNode } from "@tiptap/pm/model";
import { parseMarkdown, serializeMarkdown } from "../adapter";
import { parseMarkdownToMdast } from "../parser";
import { getProductionSchema } from "@/test/productionSchema";

const schema = getProductionSchema();
const roundTrip = (markdown: string): string =>
  serializeMarkdown(schema, parseMarkdown(schema, markdown));

/** The private-use characters that stand in for escaped markers during a parse. */
const PLACEHOLDER = /[\uE001-\uE004]/;

const tree = (markdown: string): string =>
  JSON.stringify(parseMarkdownToMdast(markdown), (key, value: unknown) =>
    key === "position" ? undefined : value,
  );

/** The mdast nodes of `markdown` with the given type, in document order. */
function nodesOf(markdown: string, type: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === type) found.push(record);
    if (Array.isArray(record.children)) record.children.forEach(walk);
  };
  walk(parseMarkdownToMdast(markdown));
  return found;
}

function markNames(doc: PMNode): string[] {
  const names = new Set<string>();
  doc.descendants((node) => {
    node.marks.forEach((mark) => names.add(mark.type.name));
  });
  return [...names].sort();
}

describe("escaped markers — an escape is honoured wherever text is read", () => {
  it.each([
    ["a stray backtick earlier in the document", "a ` b\n\nc \\==not highlight\\== d\n"],
    ["a stray backtick on the same line", "a ` b \\==not highlight\\== c\n"],
    ["two stray backtick runs of different lengths", "a `` b ` c\n\n\\==x\\==\n"],
    ["an unclosed fence-like run mid-line", "a ``` b\n\n\\==x\\==\n"],
    ["a dollar sign", "costs $5\n\n\\==x\\==\n"],
    ["an apostrophe and quotes", "it's \"so\"\n\n\\==x\\==\n"],
  ])("after %s", (_label, source) => {
    const doc = parseMarkdown(schema, source);
    expect(markNames(doc)).toEqual([]);
    expect(doc.textContent).toContain("==");
    const once = roundTrip(source);
    expect(markNames(parseMarkdown(schema, once))).toEqual([]);
    expect(roundTrip(once)).toBe(once);
  });

  it.each([
    ["highlight", "\\==x\\==", "==x=="],
    ["underline", "\\++x\\++", "++x++"],
    ["superscript", "x\\^2\\^", "x^2^"],
    ["subscript", "H\\~2\\~O", "H~2~O"],
  ])("keeps an escaped %s literal", (_label, source, text) => {
    const doc = parseMarkdown(schema, `${source}\n`);
    expect(markNames(doc)).toEqual([]);
    expect(doc.textContent).toBe(text);
  });

  it("reads an escaped backslash before a marker as a backslash and a real marker", () => {
    // `\\` is one literal backslash; the `==` after it is not escaped.
    const doc = parseMarkdown(schema, "a \\\\==hl== b\n");
    expect(markNames(doc)).toEqual(["highlight"]);
    expect(doc.textContent).toBe("a \\hl b");
    const once = roundTrip("a \\\\==hl== b\n");
    expect(markNames(parseMarkdown(schema, once))).toEqual(["highlight"]);
    expect(roundTrip(once)).toBe(once);
  });

  it("reads three backslashes before a marker as a backslash and an escaped marker", () => {
    const doc = parseMarkdown(schema, "a \\\\\\==x== b\n");
    expect(markNames(doc)).toEqual([]);
    expect(doc.textContent).toBe("a \\==x== b");
  });
});

describe("escaped markers — where escapes are not read, the text stays as written", () => {
  it.each([
    ["inline code", "`a \\== b \\~ c`\n", "inlineCode", "a \\== b \\~ c"],
    ["fenced code", "```\na \\== b\n```\n", "code", "a \\== b"],
    ["indented code", "para\n\n    code \\== x \\^ y\n", "code", "code \\== x \\^ y"],
    ["inline math", "$a\\^b + \\~{n}$\n", "inlineMath", "a\\^b + \\~{n}"],
    ["a math block", "$$\nx\\~y \\^ z\n$$\n", "math", "x\\~y \\^ z"],
    ["an HTML block", '<div data-x="\\==">\n', "html", '<div data-x="\\==">'],
    ["inline HTML", 'a <span title="\\~">b</span>\n', "html", '<span title="\\~">'],
    ["frontmatter", "---\na: \\~\n---\n\nx\n", "yaml", "a: \\~"],
  ])("in %s", (_label, source, type, value) => {
    expect(nodesOf(source, type)[0]?.value).toBe(value);
    expect(tree(source)).not.toMatch(PLACEHOLDER);
  });

  it("keeps an autolink's address as written", () => {
    const [link] = nodesOf("<http://x.test/\\~user>\n", "link");
    expect(link.url).toBe("http://x.test/\\~user");
    expect(tree("<http://x.test/\\~user>\n")).not.toMatch(PLACEHOLDER);
  });
});

describe("escaped markers — where escapes are read, the marker is literal", () => {
  it.each([
    ["a link destination", "[a](http://x.test/\\~user)\n", "link", "url", "http://x.test/~user"],
    ["a link title", '[a](u "t \\== t")\n', "link", "title", "t == t"],
    ["image alt text", "![a \\== b](u)\n", "image", "alt", "a == b"],
    ["a definition's address", "[a]\n\n[a]: http://x.test/\\~u\n", "definition", "url", "http://x.test/~u"],
    ["a fence's info string", "```a\\~b\ncode\n```\n", "code", "lang", "a~b"],
  ])("in %s", (_label, source, type, field, value) => {
    expect(nodesOf(source, type)[0]?.[field]).toBe(value);
    expect(tree(source)).not.toMatch(PLACEHOLDER);
  });

  it("in a <details> summary and body", () => {
    const source = "<details>\n<summary>a \\~ b</summary>\n\nbody \\== x\n\n</details>\n";
    expect(tree(source)).not.toMatch(PLACEHOLDER);
    const doc = parseMarkdown(schema, source);
    expect(markNames(doc)).toEqual([]);
    expect(doc.textContent).toBe("a ~ bbody == x");
  });
});

describe("escaped markers — a <details> summary", () => {
  it.each([
    ["highlight", "\\==x\\==", "==x=="],
    ["underline", "\\++x\\++", "++x++"],
    ["superscript", "x\\^2\\^", "x^2^"],
    ["subscript", "H\\~2\\~O", "H~2~O"],
  ])("keeps an escaped %s literal, as the body does", (_label, summary, text) => {
    const source = `<details>\n<summary>${summary}</summary>\n\nbody\n\n</details>\n`;
    const doc = parseMarkdown(schema, source);
    expect(markNames(doc)).toEqual([]);
    expect(doc.textContent).toBe(`${text}body`);
  });

  it("still reads real marks in a summary", () => {
    const doc = parseMarkdown(schema, "<details>\n<summary>a ==b== c</summary>\n\nbody\n\n</details>\n");
    expect(markNames(doc)).toEqual(["highlight"]);
  });
});

describe("escaped markers — generated documents", () => {
  const piece = fc.constantFrom(
    "a", "b c", "\\==", "\\++", "\\^", "\\~", "\\\\", "`", "``", "$", "$$", "==", "~", "^", "<b>", "</b>",
    "[l](u\\~v)", "![i\\^](u)", "<http://h/\\~p>", "http://h/\\~p", "\n", "\n\n", "    ", "> ", "- ", "```\n",
    "<div>\n", "</div>\n", "| ", "中", "😀", "*", "_", "\\", " ",
  );
  const document = fc.array(piece, { minLength: 1, maxLength: 24 }).map((pieces) => pieces.join(""));

  it("never leave a placeholder in the parsed tree", () => {
    fc.assert(
      fc.property(document, (source) => {
        expect(tree(source)).not.toMatch(PLACEHOLDER);
      }),
      { numRuns: 500, seed: 20261002 },
    );
  });

  it("never write a placeholder to the file", () => {
    fc.assert(
      fc.property(document, (source) => {
        expect(roundTrip(source)).not.toMatch(PLACEHOLDER);
      }),
      { numRuns: 300, seed: 20261002 },
    );
  });
});
