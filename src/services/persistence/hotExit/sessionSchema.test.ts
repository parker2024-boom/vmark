// @vitest-environment node
// WI-RA18.9 — the session schemas on zod/mini keep classic zod's behaviour:
// the same values pass and fail, and quarantine reasons read the same English.
import { describe, expect, it } from "vitest";
import type { ZodMiniType } from "zod/mini";
import {
  instanceUiStateSchema,
  schemaReason,
  sessionEnvelopeSchema,
  tabStateSchema,
} from "./sessionSchema";

function reasonFor(schema: ZodMiniType, value: unknown): string {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected the value to fail its schema");
  return schemaReason(result.error);
}

const uiState = {
  sidebarWidth: 240,
  sidebarViewMode: "files",
  fileExplorerOpenState: null,
  fileTreeScrollOffset: 0,
  outlineByTabId: {},
};

describe("sessionSchema — quarantine reasons", () => {
  it("names the path and the expected type, in English", () => {
    expect(reasonFor(tabStateSchema, { id: "t1", title: "a.md", document: { saved_content: "" } }))
      .toBe("document.content: Invalid input: expected string, received undefined");
  });

  it("lists the allowed options of an enum", () => {
    const tab = { id: "t1", title: "a.md", document: { content: "", saved_content: "", mode: "split" } };
    expect(reasonFor(tabStateSchema, tab)).toBe(
      'document.mode: Invalid option: expected one of "wysiwyg"|"source"',
    );
  });

  it("joins several issues with a semicolon", () => {
    expect(reasonFor(sessionEnvelopeSchema, { version: "5", timestamp: 1, windows: [] })).toBe(
      "version: Invalid input: expected number, received string; "
        + "vmark_version: Invalid input: expected string, received undefined",
    );
  });
});

describe("sessionSchema — accepted values", () => {
  it.each([Infinity, -Infinity, NaN])("refuses a non-finite sidebar width (%s)", (width) => {
    expect(instanceUiStateSchema.safeParse({ ...uiState, sidebarWidth: width }).success).toBe(false);
  });

  it("accepts a null sidebar width and keeps unknown fields", () => {
    const value = { ...uiState, sidebarWidth: null, futureField: "x" };
    const result = instanceUiStateSchema.safeParse(value);
    expect(result.success && result.data).toEqual(value);
  });

  it("treats nullish tab fields as absent, not corrupt", () => {
    const tab = {
      id: "t1",
      title: "a.md",
      file_path: null,
      active_schema_id: undefined,
      document: { content: "", saved_content: "", last_modified_timestamp: null },
    };
    expect(tabStateSchema.safeParse(tab).success).toBe(true);
  });
});
