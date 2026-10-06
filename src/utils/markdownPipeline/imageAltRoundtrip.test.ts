// @vitest-environment node
// WI-RA2.3 — image alt text survives a save whatever characters it holds. An
// alt is read back as inline markdown and flattened to text, so anything that
// could start markup has to be escaped when it is written.
import { describe, it, expect } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { parseMarkdown, serializeMarkdown } from "./adapter";
import { getProductionSchema } from "@/test/productionSchema";

const schema = getProductionSchema();

function alts(doc: PMNode): string[] {
  const found: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "image" || node.type.name === "block_image") {
      found.push(String(node.attrs.alt ?? ""));
    }
  });
  return found;
}

/** A document holding one inline image and one block image with this alt. */
function withAlt(alt: string): PMNode {
  const inline = schema.nodes.image.create({ src: "x.png", alt });
  const paragraph = schema.nodes.paragraph.create(null, [schema.text("see "), inline, schema.text(" here")]);
  const block = schema.nodes.block_image.create({ src: "y.png", alt });
  return schema.topNodeType.create(null, [paragraph, block]);
}

describe("image alt text", () => {
  it.each([
    ["underscore emphasis", "a _c_ b"],
    ["asterisk emphasis", "a *b* c"],
    ["strong", "a **b** c"],
    ["a code span", "a `d` b"],
    ["brackets", "a [f] b"],
    ["a link", "a [f](u) b"],
    ["a nested image", "a ![n](u) b"],
    ["a backslash", "a\\b"],
    ["a trailing backslash", "a\\"],
    ["a highlight", "a ==h== b"],
    ["strikethrough", "a ~~s~~ b"],
    ["a subscript", "H~2~O"],
    ["inline math", "cost $x$ and $y$"],
    ["a tag", "a <b>c</b> d"],
    ["a character reference", "a &amp; b"],
    ["an autolink", "see https://example.com now"],
    ["CJK with markers", "中文 *强调* 文本"],
    ["an emoji", "😀 _x_"],
    ["plain text", "plain alt text"],
    ["nothing", ""],
  ])("keeps %s across two saves", (_label, alt) => {
    const doc = withAlt(alt);
    const once = serializeMarkdown(schema, doc);
    const first = parseMarkdown(schema, once);
    expect(alts(first)).toEqual([alt, alt]);
    const twice = serializeMarkdown(schema, first);
    expect(twice).toBe(once);
    expect(alts(parseMarkdown(schema, twice))).toEqual([alt, alt]);
  });

  it("writes an alt that needs no escaping as it is", () => {
    const once = serializeMarkdown(schema, withAlt("A plain photo, 2 of 3"));
    expect(once).toContain("![A plain photo, 2 of 3](x.png)");
  });
});
