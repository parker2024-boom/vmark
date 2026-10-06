// @vitest-environment node
/**
 * Tests for proseMirrorToMdast — PM document to MDAST tree conversion, through
 * the real block and inline converters.
 *
 * Covers:
 *   - Basic block nodes: paragraph, heading, codeBlock, horizontalRule
 *   - Inline nodes converted at block level: hardBreak, image, math_inline,
 *     footnote_reference
 *   - Media blocks: block_video, block_audio, video_embed
 *   - Footnote definitions with several blocks
 *   - Unknown node type warning (the node is dropped)
 *   - ListItem filtering at root level
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Schema } from "@tiptap/pm/model";

vi.mock("@/utils/debug", () => ({
  mdPipelineWarn: vi.fn(),
}));

import { proseMirrorToMdast } from "./proseMirrorToMdast";
import { mdPipelineWarn } from "@/utils/debug";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
    codeBlock: { content: "text*", group: "block", attrs: { language: { default: "" } } },
    horizontalRule: { group: "block" },
    text: { group: "inline" },
    hardBreak: { group: "inline", inline: true },
    image: { group: "inline", inline: true, attrs: { src: { default: "" } } },
  },
});

function createDoc(children: ReturnType<typeof schema.node>[]) {
  return schema.node("doc", null, children);
}

/** A schema where `name` (with `attrs`) may sit directly under the doc. */
function looseSchemaWith(name: string, spec: Record<string, unknown>) {
  return new Schema({
    nodes: {
      doc: { content: "block+" },
      [name]: { group: "block", ...spec },
      paragraph: { content: "inline*", group: "block" },
      text: { group: "inline" },
    },
  });
}

describe("proseMirrorToMdast", () => {
  beforeEach(() => {
    vi.mocked(mdPipelineWarn).mockClear();
  });

  it("converts a document with a paragraph", () => {
    const doc = createDoc([schema.node("paragraph", null, [schema.text("Hello")])]);
    const result = proseMirrorToMdast(schema, doc);
    expect(result).toEqual({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "Hello" }] }],
    });
  });

  it("converts a document with a heading", () => {
    const doc = createDoc([schema.node("heading", { level: 2 }, [schema.text("Title")])]);
    const result = proseMirrorToMdast(schema, doc);
    expect(result.children).toEqual([
      { type: "heading", depth: 2, children: [{ type: "text", value: "Title" }] },
    ]);
  });

  it("converts a document with code block", () => {
    const doc = createDoc([schema.node("codeBlock", { language: "js" }, [schema.text("code")])]);
    const result = proseMirrorToMdast(schema, doc);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ type: "code", lang: "js", value: "code" });
  });

  it("converts a document with horizontal rule", () => {
    const doc = createDoc([schema.node("horizontalRule")]);
    const result = proseMirrorToMdast(schema, doc);
    expect(result.children).toEqual([{ type: "thematicBreak" }]);
  });

  it("converts an empty paragraph to a paragraph with no children", () => {
    const doc = createDoc([schema.node("paragraph")]);
    const result = proseMirrorToMdast(schema, doc);
    expect(result.children).toEqual([{ type: "paragraph", children: [] }]);
  });

  it("converts inline hard breaks and images inside a paragraph", () => {
    const doc = createDoc([
      schema.node("paragraph", null, [
        schema.text("a"),
        schema.node("hardBreak"),
        schema.node("image", { src: "pic.png" }),
      ]),
    ]);
    const result = proseMirrorToMdast(schema, doc);
    const para = result.children[0] as { type: string; children: Array<{ type: string; url?: string }> };
    expect(para.type).toBe("paragraph");
    expect(para.children.map((c) => c.type)).toEqual(["text", "break", "image"]);
    expect(para.children[2].url).toBe("pic.png");
  });

  it("filters out listItem nodes at root level", () => {
    const listSchema = looseSchemaWith("listItem", { content: "paragraph+" });
    const doc = listSchema.node("doc", null, [
      listSchema.node("listItem", null, [listSchema.node("paragraph", null, [listSchema.text("orphan")])]),
      listSchema.node("paragraph", null, [listSchema.text("kept")]),
    ]);
    const result = proseMirrorToMdast(listSchema, doc);
    expect(result.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "kept" }] },
    ]);
  });

  it("warns on unknown node type and drops it", () => {
    // Create a schema with an unknown node type using OrderedMap append
    const extSchema = new Schema({
      nodes: schema.spec.nodes.append({
        customUnknown: { group: "block", content: "text*" },
      }),
    });
    const doc = extSchema.node("doc", null, [
      extSchema.node("customUnknown"),
      extSchema.node("horizontalRule"),
    ]);
    const result = proseMirrorToMdast(extSchema, doc);
    expect(mdPipelineWarn).toHaveBeenCalledWith(
      expect.stringContaining("Unknown node type: customUnknown")
    );
    expect(result.children).toEqual([{ type: "thematicBreak" }]);
  });

  it("converts multiple block nodes in order", () => {
    const doc = createDoc([
      schema.node("paragraph", null, [schema.text("First")]),
      schema.node("horizontalRule"),
      schema.node("paragraph", null, [schema.text("Second")]),
    ]);
    const result = proseMirrorToMdast(schema, doc);
    expect(result.children.map((c) => c.type)).toEqual(["paragraph", "thematicBreak", "paragraph"]);
  });

  it("converts block_video nodes with a video extension to image syntax", () => {
    const videoSchema = new Schema({
      nodes: schema.spec.nodes.append({
        block_video: { group: "block", attrs: { src: { default: "" } } },
      }),
    });
    const doc = videoSchema.node("doc", null, [
      videoSchema.node("block_video", { src: "video.mp4" }),
    ]);
    const result = proseMirrorToMdast(videoSchema, doc);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "image", url: "video.mp4" }],
    });
  });

  it("converts block_video nodes without a media extension to an HTML fallback", () => {
    const videoSchema = new Schema({
      nodes: schema.spec.nodes.append({
        block_video: { group: "block", attrs: { src: { default: "" } } },
      }),
    });
    const doc = videoSchema.node("doc", null, [
      videoSchema.node("block_video", { src: "https://cdn.example/stream" }),
    ]);
    const result = proseMirrorToMdast(videoSchema, doc);
    expect(result.children[0]).toMatchObject({ type: "html" });
    expect((result.children[0] as { value: string }).value).toContain("<video");
  });

  it("converts block_audio nodes", () => {
    const audioSchema = new Schema({
      nodes: schema.spec.nodes.append({
        block_audio: { group: "block", attrs: { src: { default: "" } } },
      }),
    });
    const doc = audioSchema.node("doc", null, [
      audioSchema.node("block_audio", { src: "audio.mp3" }),
    ]);
    const result = proseMirrorToMdast(audioSchema, doc);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "image", url: "audio.mp3" }],
    });
  });

  it("converts video_embed nodes", () => {
    const embedSchema = new Schema({
      nodes: schema.spec.nodes.append({
        video_embed: { group: "block", attrs: { src: { default: "" } } },
      }),
    });
    const doc = embedSchema.node("doc", null, [
      embedSchema.node("video_embed", { src: "https://youtube.com/x" }),
    ]);
    const result = proseMirrorToMdast(embedSchema, doc);
    expect(result.children).toHaveLength(1);
    expect(result.children[0].type).toBe("html");
  });

  it("converts hardBreak nodes at block level", () => {
    const looseSchema = looseSchemaWith("hardBreak", {});
    const doc = looseSchema.node("doc", null, [looseSchema.node("hardBreak")]);
    const result = proseMirrorToMdast(looseSchema, doc);
    expect(result.children).toEqual([{ type: "break" }]);
  });

  it("converts image nodes at block level", () => {
    const looseSchema = looseSchemaWith("image", { attrs: { src: { default: "" } } });
    const doc = looseSchema.node("doc", null, [looseSchema.node("image", { src: "img.png" })]);
    const result = proseMirrorToMdast(looseSchema, doc);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ type: "image", url: "img.png" });
  });

  it("converts math_inline nodes at block level", () => {
    const looseSchema = looseSchemaWith("math_inline", { attrs: { content: { default: "" } } });
    const doc = looseSchema.node("doc", null, [
      looseSchema.node("math_inline", { content: "E=mc^2" }),
    ]);
    const result = proseMirrorToMdast(looseSchema, doc);
    expect(result.children).toEqual([{ type: "inlineMath", value: "E=mc^2" }]);
  });

  it("converts footnote_reference nodes at block level", () => {
    const looseSchema = looseSchemaWith("footnote_reference", { attrs: { label: { default: "1" } } });
    const doc = looseSchema.node("doc", null, [
      looseSchema.node("footnote_reference", { label: "7" }),
    ]);
    const result = proseMirrorToMdast(looseSchema, doc);
    expect(result.children).toEqual([{ type: "footnoteReference", identifier: "7", label: "7" }]);
  });

  it("converts a footnote_definition holding several blocks", () => {
    const looseSchema = looseSchemaWith("footnote_definition", {
      content: "block+",
      attrs: { label: { default: "1" } },
    });
    const doc = looseSchema.node("doc", null, [
      looseSchema.node("footnote_definition", { label: "2" }, [
        looseSchema.node("paragraph", null, [looseSchema.text("note")]),
        looseSchema.node("paragraph", null, [looseSchema.text("more")]),
      ]),
    ]);
    const result = proseMirrorToMdast(looseSchema, doc);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      type: "footnoteDefinition",
      identifier: "2",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "note" }] },
        { type: "paragraph", children: [{ type: "text", value: "more" }] },
      ],
    });
  });
});
