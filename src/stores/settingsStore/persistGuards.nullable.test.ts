// @vitest-environment node
// WI-RA22.2 — a nullable setting accepts null or its declared type, nothing else
import { describe, expect, it } from "vitest";
import { initialState } from "./defaults";
import { NULLABLE_LEAF_TYPES, sanitizePersistedSettings } from "./persistGuards";

const defaults = initialState as unknown as Record<string, unknown>;

function sanitizeUpdate(update: Record<string, unknown>): Record<string, unknown> {
  const out = sanitizePersistedSettings({ update }, defaults);
  return out.update as Record<string, unknown>;
}

describe("nullable settings are type-checked at load", () => {
  it.each([
    ["skipVersion", "1.2.3"],
    ["skipVersion", ""],
    ["skipVersion", "版本-2"],
    ["skipVersion", null],
    ["lastCheckTimestamp", 1_700_000_000_000],
    ["lastCheckTimestamp", 0],
    ["lastCheckTimestamp", null],
  ])("keeps %s = %j", (key, value) => {
    expect(sanitizeUpdate({ [key]: value })).toEqual({ [key]: value });
  });

  it.each([
    ["skipVersion", 42],
    ["skipVersion", true],
    ["skipVersion", ["1.2.3"]],
    ["skipVersion", { v: "1.2.3" }],
    ["lastCheckTimestamp", "1700000000000"],
    ["lastCheckTimestamp", Number.POSITIVE_INFINITY],
    ["lastCheckTimestamp", Number.NaN],
    ["lastCheckTimestamp", false],
  ])("drops %s = %j", (key, value) => {
    expect(sanitizeUpdate({ [key]: value })).toEqual({});
  });

  it("drops any non-null value for a null default with no declared type", () => {
    const out = sanitizePersistedSettings(
      { section: { undeclared: "anything" } },
      { section: { undeclared: null } },
    );
    expect(out).toEqual({ section: {} });
  });

  it("keeps null for a null default with no declared type", () => {
    const out = sanitizePersistedSettings(
      { section: { undeclared: null } },
      { section: { undeclared: null } },
    );
    expect(out).toEqual({ section: { undeclared: null } });
  });
});

describe("every nullable default has a declared type", () => {
  function nullLeafPaths(node: Record<string, unknown>, prefix: string): string[] {
    return Object.entries(node).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value === null) return [path];
      if (typeof value === "object" && !Array.isArray(value)) {
        return nullLeafPaths(value as Record<string, unknown>, path);
      }
      return [];
    });
  }

  it("matches the null leaves of the defaults exactly", () => {
    expect(Object.keys(NULLABLE_LEAF_TYPES).sort()).toEqual(
      nullLeafPaths(defaults, "").sort(),
    );
  });
});
