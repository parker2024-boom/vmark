// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("katexLoader", () => {
  beforeEach(() => {
    // Reset module state between tests
    vi.resetModules();
  });

  describe("isKatexLoaded", () => {
    it("returns false before first load", async () => {
      const { isKatexLoaded } = await import("./katexLoader");
      expect(isKatexLoaded()).toBe(false);
    });

    it("returns true after load completes", async () => {
      const { loadKatex, isKatexLoaded } = await import("./katexLoader");
      await loadKatex();
      expect(isKatexLoaded()).toBe(true);
    });
  });

  describe("loadKatex", () => {
    it("returns same promise for concurrent calls", async () => {
      const { loadKatex } = await import("./katexLoader");
      const p1 = loadKatex();
      const p2 = loadKatex();
      // Both should resolve to the same module
      const [m1, m2] = await Promise.all([p1, p2]);
      expect(m1).toBe(m2);
    });

    it("returns cached module on subsequent calls", async () => {
      const { loadKatex } = await import("./katexLoader");
      const m1 = await loadKatex();
      const m2 = await loadKatex();
      expect(m1).toBe(m2);
    });

    it("retries after a failed chunk load instead of caching the rejection", async () => {
      let attempts = 0;
      vi.doMock("katex", async (importOriginal) => {
        attempts += 1;
        if (attempts === 1) throw new Error("chunk load failed");
        return importOriginal();
      });
      try {
        const { loadKatex, isKatexLoaded } = await import("./katexLoader");
        await expect(loadKatex()).rejects.toThrow();
        expect(isKatexLoaded()).toBe(false);

        const katex = await loadKatex();
        expect(attempts).toBe(2);
        expect(typeof katex.default.render).toBe("function");
        expect(isKatexLoaded()).toBe(true);
      } finally {
        vi.doUnmock("katex");
      }
    });

    it("returns a valid katex module", async () => {
      const { loadKatex } = await import("./katexLoader");
      const katex = await loadKatex();
      expect(katex).toBeDefined();
      expect(katex.default).toBeDefined();
      expect(typeof katex.default.render).toBe("function");
    });
  });

  describe("getKatexModule", () => {
    it("returns null before first load", async () => {
      const { getKatexModule } = await import("./katexLoader");
      expect(getKatexModule()).toBeNull();
    });

    it("returns module after load", async () => {
      const { loadKatex, getKatexModule } = await import("./katexLoader");
      await loadKatex();
      expect(getKatexModule()).not.toBeNull();
    });
  });
});
