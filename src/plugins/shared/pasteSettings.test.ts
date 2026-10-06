// @vitest-environment node
/**
 * The paste plugins' own vocabulary and its standalone default. Each paste
 * plugin pins that it falls back to this default in its own test file.
 *
 * @coordinates-with plugins/shared/pasteSettings.ts
 * @module plugins/shared/pasteSettings.test
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_PASTE_SETTINGS } from "./pasteSettings";

describe("a host that configures nothing still gets sane paste behaviour", () => {
  it("defaults to smart paste with breaks not preserved", () => {
    expect(DEFAULT_PASTE_SETTINGS).toEqual({ pasteMode: "smart", preserveLineBreaks: false });
  });
});
