// @vitest-environment node
// WI-RA26.4 — the build-time version constant survives vi.unstubAllGlobals().
//
// The app build defines `__VMARK_VERSION__` (vite.config.ts `define`). Tests
// used to get it from `vi.stubGlobal` in src/test/setup.ts, and 35 test files
// call `vi.unstubAllGlobals()`, which removed it for every later test in those
// files: a module that reads it then threw a ReferenceError. The vitest
// configs now define it the way the build does, so no test can remove it.
import { describe, expect, it, vi } from "vitest";

describe("__VMARK_VERSION__ in tests", () => {
  it("is the stable test version", () => {
    expect(__VMARK_VERSION__).toBe("0.0.0-test");
  });

  it("is still defined after vi.unstubAllGlobals()", () => {
    vi.unstubAllGlobals();
    expect(__VMARK_VERSION__).toBe("0.0.0-test");
  });

  it("a module that reads it at import time still loads after vi.unstubAllGlobals()", async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const dispatch = await import("@/services/mcpBridge/v2/dispatch");
    expect(dispatch).toBeDefined();
  });
});
