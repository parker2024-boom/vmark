// @vitest-environment node
/**
 * Tests for ES2022 error wrapping in the markdown pipeline adapter.
 *
 * Verifies that parseMarkdown and serializeMarkdown properly wrap errors
 * using `new Error(message, { cause })` (ES2022) instead of unsafe casts.
 */

import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { parseMarkdown, serializeMarkdown } from "../adapter";
import type { MarkdownPipelineOptions } from "../types";

// The adapter's job here is the wrapping, so each fault is injected through
// the adapter's own INPUTS and the real pipeline runs up to the point where it
// touches the poisoned input: the options object (read by the parser and the
// serializer), the schema (read by the MDAST → ProseMirror step) and the
// document (walked by the ProseMirror → MDAST step).

/** Options whose every property read throws `thrown`, except the keys named in `allow`. */
function optionsThatThrow(thrown: unknown, allow: readonly string[] = []): MarkdownPipelineOptions {
  return new Proxy({} as MarkdownPipelineOptions, {
    get(_target, key) {
      if (typeof key === "string" && allow.includes(key)) return undefined;
      throw thrown;
    },
  });
}

/** A schema whose every property read throws `thrown`. */
function schemaThatThrows(thrown: unknown): Parameters<typeof parseMarkdown>[0] {
  return new Proxy({} as Parameters<typeof parseMarkdown>[0], {
    get() {
      throw thrown;
    },
  });
}

// Never reached by the parse-step faults: the parser throws first.
const mockSchema = {} as Parameters<typeof parseMarkdown>[0];

const realSchema = new Schema({
  nodes: { doc: { content: "paragraph*" }, paragraph: { content: "text*" }, text: {} },
});

/**
 * A document reporting the given child count and size whose traversal (the
 * ProseMirror → MDAST step walks it with `forEach`) throws `fault.thrown`.
 */
function createMockDoc(childCount: number, size: number, fault: { thrown: unknown }) {
  return {
    content: { childCount, size },
    forEach() {
      throw fault.thrown;
    },
  } as unknown as Parameters<typeof serializeMarkdown>[1];
}

describe("parseMarkdown error wrapping", () => {
  describe("cause preserves original error", () => {
    it("wraps Error with correct message prefix", () => {
      const original = new Error("remark exploded");
      const fault = { thrown: original };

      expect(() => parseMarkdown(mockSchema, "# Hello", optionsThatThrow(fault.thrown))).toThrow(
        /\[MarkdownPipeline\] Parse failed: remark exploded/,
      );
    });

    it("sets cause to the original Error instance (same reference)", () => {
      const original = new Error("parser failure");
      const fault = { thrown: original };

      try {
        parseMarkdown(mockSchema, "# Hello", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).cause).toBe(original);
      }
    });

    it("wrapped error is instanceof Error", () => {
      const fault = { thrown: new Error("boom") };

      try {
        parseMarkdown(mockSchema, "test", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    });

    it("wrapped error has a stack trace", () => {
      const fault = { thrown: new Error("stack check") };

      try {
        parseMarkdown(mockSchema, "test", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).stack).toBeDefined();
        expect((err as Error).stack).toContain("Error");
      }
    });
  });

  describe("cause works with non-Error values", () => {
    it.each([
      { label: "string", value: "something went wrong" },
      { label: "number", value: 42 },
      { label: "null", value: null },
      { label: "undefined", value: undefined },
      { label: "boolean", value: false },
      { label: "object", value: { code: "ENOENT" } },
      { label: "array", value: [1, 2, 3] },
    ])("preserves $label as cause", ({ value }) => {
      const fault = { thrown: value };

      try {
        parseMarkdown(mockSchema, "test", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).cause).toBe(value);
      }
    });
  });

  describe("error message includes input context", () => {
    it("includes short input as preview", () => {
      const fault = { thrown: new Error("fail") };

      try {
        parseMarkdown(mockSchema, "short input", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain('Input preview: "short input"');
      }
    });

    it("truncates long input to 100 chars with ellipsis", () => {
      const longInput = "x".repeat(200);
      const fault = { thrown: new Error("fail") };

      try {
        parseMarkdown(mockSchema, longInput, optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("x".repeat(100) + "...");
        expect(msg).not.toContain("x".repeat(101));
      }
    });

    it("does not add ellipsis for exactly 100 chars", () => {
      const exact100 = "y".repeat(100);
      const fault = { thrown: new Error("fail") };

      try {
        parseMarkdown(mockSchema, exact100, optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain(`Input preview: "${exact100}"`);
        expect(msg).not.toContain("...");
      }
    });

    it("includes empty string preview for empty input", () => {
      const fault = { thrown: new Error("fail") };

      try {
        parseMarkdown(mockSchema, "", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain('Input preview: ""');
      }
    });
  });

  describe("message formatting for non-Error thrown values", () => {
    it("stringifies a thrown string in the message", () => {
      const fault = { thrown: "raw string error" };

      try {
        parseMarkdown(mockSchema, "test", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain(
          "[MarkdownPipeline] Parse failed: raw string error",
        );
      }
    });

    it("stringifies a thrown number in the message", () => {
      const fault = { thrown: 404 };

      try {
        parseMarkdown(mockSchema, "test", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain(
          "[MarkdownPipeline] Parse failed: 404",
        );
      }
    });
  });

  describe("edge cases", () => {
    it("handles original error with its own cause (nested cause chain)", () => {
      const rootCause = new Error("root cause");
      const midError = new Error("mid error", { cause: rootCause });
      const fault = { thrown: midError };

      try {
        parseMarkdown(mockSchema, "test", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        const wrapped = err as Error;
        // Direct cause is the midError
        expect(wrapped.cause).toBe(midError);
        // The chain is preserved: wrapped -> midError -> rootCause
        expect((wrapped.cause as Error).cause).toBe(rootCause);
      }
    });

    it("handles error with extra properties beyond message/stack", () => {
      const original = new Error("custom error");
      (original as Error & { code: string }).code = "CUSTOM_CODE";
      (original as Error & { details: object }).details = { key: "value" };
      const fault = { thrown: original };

      try {
        parseMarkdown(mockSchema, "test", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        // cause preserves the original object with all its properties
        const cause = (err as Error).cause as Error & { code: string; details: object };
        expect(cause).toBe(original);
        expect(cause.code).toBe("CUSTOM_CODE");
        expect(cause.details).toEqual({ key: "value" });
      }
    });

    it("handles input with special characters and unicode", () => {
      const fault = { thrown: new Error("fail") };

      const unicodeInput = '# 你好世界 — em-dash "quotes" <tags> \n\t\0';
      try {
        parseMarkdown(mockSchema, unicodeInput, optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain("你好世界");
        expect((err as Error).cause).toBeInstanceOf(Error);
      }
    });

    it("handles circular reference as cause without crashing", () => {
      const circular: Record<string, unknown> = { name: "circular" };
      circular.self = circular;

      const fault = { thrown: circular };

      // Should not crash — ES2022 cause accepts any value
      try {
        parseMarkdown(mockSchema, "test", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).cause).toBe(circular);
      }
    });

    it("handles very long error message", () => {
      const longMsg = "x".repeat(10000);
      const fault = { thrown: new Error(longMsg) };

      try {
        parseMarkdown(mockSchema, "test", optionsThatThrow(fault.thrown));
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain(longMsg);
      }
    });

    it("wraps errors from mdastToProseMirror step too", () => {
      const original = new Error("PM conversion failed");

      try {
        parseMarkdown(schemaThatThrows(original), "test");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain(
          "[MarkdownPipeline] Parse failed: PM conversion failed",
        );
        expect((err as Error).cause).toBe(original);
      }
    });
  });
});

describe("serializeMarkdown error wrapping", () => {
  describe("cause preserves original error", () => {
    it("wraps Error with correct message prefix", () => {
      const original = new Error("serialize exploded");
      const fault = { thrown: original };

      expect(() => serializeMarkdown(mockSchema, createMockDoc(2, 100, fault))).toThrow(
        /\[MarkdownPipeline\] Serialize failed: serialize exploded/,
      );
    });

    it("sets cause to the original Error instance (same reference)", () => {
      const original = new Error("serializer failure");
      const fault = { thrown: original };

      try {
        serializeMarkdown(mockSchema, createMockDoc(2, 100, fault));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).cause).toBe(original);
      }
    });
  });

  describe("error message includes doc context", () => {
    it("includes node count and doc size", () => {
      const fault = { thrown: new Error("fail") };

      try {
        serializeMarkdown(mockSchema, createMockDoc(5, 250, fault));
        expect.fail("should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("Doc info: 5 nodes, size 250");
      }
    });

    it("includes zero counts for empty doc", () => {
      const fault = { thrown: new Error("fail") };

      try {
        serializeMarkdown(mockSchema, createMockDoc(0, 0, fault));
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain("Doc info: 0 nodes, size 0");
      }
    });
  });

  describe("cause works with non-Error values", () => {
    it.each([
      { label: "string", value: "raw error" },
      { label: "number", value: 500 },
      { label: "null", value: null },
      { label: "undefined", value: undefined },
    ])("preserves $label as cause", ({ value }) => {
      const fault = { thrown: value };

      try {
        serializeMarkdown(mockSchema, createMockDoc(2, 100, fault));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).cause).toBe(value);
      }
    });
  });

  describe("wraps errors from serializer step", () => {
    it("wraps errors thrown by serializeMdastToMarkdown", () => {
      const original = new Error("serializer step failed");
      // The adapter reads preserveBlankLines itself; every other option read
      // happens in the serializer, after the ProseMirror → MDAST step succeeded.
      const options = optionsThatThrow(original, ["preserveBlankLines"]);
      const doc = realSchema.node("doc", null, [realSchema.node("paragraph", null, [realSchema.text("hi")])]);

      try {
        serializeMarkdown(realSchema, doc, options);
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain(
          "[MarkdownPipeline] Serialize failed: serializer step failed",
        );
        expect((err as Error).message).toContain("Doc info: 1 nodes, size 4");
        expect((err as Error).cause).toBe(original);
      }
    });

    it("serializes normally when no input is poisoned", () => {
      const doc = realSchema.node("doc", null, [realSchema.node("paragraph", null, [realSchema.text("hi")])]);
      expect(serializeMarkdown(realSchema, doc)).toBe("hi\n");
    });
  });
});

describe("regression: no unsafe Error casts in adapter", () => {
  it("adapter.ts does not contain 'as Error &' unsafe cast pattern", async () => {
    // Read the source file and verify the old pattern is gone
    const fs = await import("fs");
    const path = await import("path");
    const adapterPath = path.resolve(
      __dirname,
      "..",
      "adapter.ts",
    );
    const source = fs.readFileSync(adapterPath, "utf-8");

    // The old pattern: (wrapped as Error & { cause?: unknown }).cause = error
    expect(source).not.toContain("as Error &");
    expect(source).not.toContain("as Error&");

    // Verify the new ES2022 pattern is used
    expect(source).toContain("{ cause: error }");
  });
});
