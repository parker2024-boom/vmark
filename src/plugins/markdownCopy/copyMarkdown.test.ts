// @vitest-environment node
// WI-RA2.4 — copying as markdown gives markdown that pastes back as what was
// copied: escapes the serializer needed are kept, code is copied byte for
// byte, and the document's hard-break style is used. Copy and Source Peek
// serialize a selection the same way.
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import type { Slice } from "@tiptap/pm/model";
import { getProductionSchema } from "@/test/productionSchema";
import { parseMarkdown } from "@/utils/markdownPipeline";
import { bindHostSettings, resetHostSettings } from "@/plugins/shared/hostSettings";
import { bindHostDocument, resetHostDocument } from "@/plugins/shared/hostDocument";
import { serializeSourcePeekRange } from "@/services/editor/sourcePeek";
import { markdownCopyExtension, trimMarkdownForClipboard } from "./tiptap";

const schema = getProductionSchema();

type Serializer = (slice: Slice, view: { state: EditorState }) => string;

function copySerializer(): Serializer {
  const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
    editor: {},
    name: "markdownCopy",
    options: { getCopyFormat: () => "markdown", getCopyOnSelect: () => false },
    storage: {},
    type: undefined,
    parent: undefined,
  } as never);
  return (plugins[0] as unknown as { props: { clipboardTextSerializer: Serializer } }).props
    .clipboardTextSerializer;
}

/** What copying the whole of `markdown`'s document as markdown puts on the clipboard. */
function copyAll(markdown: string): string {
  const doc = parseMarkdown(schema, markdown);
  const state = EditorState.create({ doc, schema });
  return copySerializer()(doc.slice(0, doc.content.size), { state });
}

afterEach(() => {
  resetHostSettings();
  resetHostDocument();
});

describe("copy as markdown — escapes that carry meaning", () => {
  it.each([
    ["a heading look-alike", "\\# not a heading\n", "\\# not a heading"],
    ["an ordered-list look-alike", "1\\. not a list\n", "1\\. not a list"],
    ["a bullet look-alike", "\\- not a list\n", "\\- not a list"],
    ["a quote look-alike", "\\> not a quote\n", "\\> not a quote"],
    // One escape is enough to keep the pair from opening.
    ["emphasis look-alikes", "\\*not em\\*\n", "\\*not em*"],
    ["a pipe in a table cell", "| a |\n| --- |\n| x\\|y |\n", "| a    |\n| ---- |\n| x\\|y |"],
  ])("keeps %s", (_label, source, expected) => {
    const copied = copyAll(source);
    expect(copied).toBe(expected);
    // Pasted back, it is the same document.
    expect(parseMarkdown(schema, copied).toJSON()).toEqual(parseMarkdown(schema, source).toJSON());
  });
});

describe("copy as markdown — code", () => {
  it.each([
    ["blank lines", "```\na\n\n\n\nb\n```\n"],
    ["trailing spaces", "```\na  \nb\t\n```\n"],
    ["backslash escapes", "```\na \\$ b \\# c \\| d\n```\n"],
    ["markdown that is not markdown here", "```md\n# h\n- l\n[x](y)\n```\n"],
    ["CJK", "```\n中文  \n\n\n日本語\n```\n"],
  ])("copies a fenced block with %s byte for byte", (_label, source) => {
    expect(copyAll(source)).toBe(source.replace(/\n$/, ""));
  });

  it("copies inline code with escapes byte for byte", () => {
    expect(copyAll("a `x \\$ y` b\n")).toBe("a `x \\$ y` b");
  });
});

describe("copy as markdown — hard breaks", () => {
  it("uses the two-space style when that is the document's", () => {
    bindHostSettings({ hardBreakStyleOnSave: () => "preserve" });
    bindHostDocument({ currentWindowLabel: () => "main", activeHardBreakStyle: () => "twoSpaces" });
    expect(copyAll("a  \nb\n")).toBe("a  \nb");
  });

  it("uses the backslash style when that is the setting", () => {
    bindHostSettings({ hardBreakStyleOnSave: () => "backslash" });
    expect(copyAll("a  \nb\n")).toBe("a\\\nb");
  });

  it("still copies when the host has no window to ask about", () => {
    bindHostDocument({
      currentWindowLabel: () => {
        throw new Error("no window");
      },
    });
    expect(copyAll("a\\\nb\n")).toBe("a  \nb");
  });
});

describe("trimMarkdownForClipboard", () => {
  it.each([
    ["leading blank lines", "\n \n\t\npara\n", "para"],
    ["trailing whitespace", "para  \n\n", "para"],
    ["CRLF blank lines", "\r\n\r\npara\r\n", "para"],
    ["nothing", "", ""],
  ])("removes %s", (_label, input, expected) => {
    expect(trimMarkdownForClipboard(input)).toBe(expected);
  });

  it("leaves the inside alone", () => {
    const inside = "a  \nb\n\n\n\n```\nx  \n\n\n\ny\n```";
    expect(trimMarkdownForClipboard(`\n${inside}\n`)).toBe(inside);
  });

  it("keeps the indentation of the first line", () => {
    expect(trimMarkdownForClipboard("\n    indented\n")).toBe("    indented");
  });
});

describe("copy as markdown — the outside of the copied text", () => {
  it("has no blank lines before or after it", () => {
    expect(copyAll("\n\npara\n\n")).toBe("para");
  });

  it("returns an empty string for an empty selection", () => {
    const doc = parseMarkdown(schema, "x\n");
    const state = EditorState.create({ doc, schema });
    expect(copySerializer()(doc.slice(1, 1), { state })).toBe("");
  });
});

describe("copy and Source Peek serialize a selection the same way", () => {
  it.each([
    "# Title\n\nPara with *em* and `code`.\n",
    "- a\n- b\n",
    "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    "\\# not a heading\n\n```\nx  \n\n\ny\n```\n",
  ])("for %j", (source) => {
    bindHostSettings({ hardBreakStyleOnSave: () => "backslash" });
    const doc = parseMarkdown(schema, source);
    const state = EditorState.create({ doc, schema });
    const peek = serializeSourcePeekRange(state, { from: 0, to: doc.content.size }, { hardBreakStyle: "backslash" });
    expect(copyAll(source)).toBe(peek.replace(/^\n+/, "").replace(/\s+$/, ""));
  });
});
