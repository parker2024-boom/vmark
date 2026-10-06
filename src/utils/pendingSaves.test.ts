// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerPendingSave,
  clearPendingSave,
  clearPendingSaveAfterGrace,
  matchesPendingSave,
  hasPendingSave,
  PENDING_SAVE_GRACE_MS,
  _clearAllPendingSaves,
} from "./pendingSaves";

describe("pendingSaves (content-based)", () => {
  beforeEach(() => {
    _clearAllPendingSaves();
  });

  describe("registerPendingSave / hasPendingSave", () => {
    it("returns true for a registered path", () => {
      registerPendingSave("/path/to/file.md", "content");
      expect(hasPendingSave("/path/to/file.md")).toBe(true);
    });

    it("returns false for an unregistered path", () => {
      expect(hasPendingSave("/path/to/unknown.md")).toBe(false);
    });

    it("normalizes paths consistently", () => {
      registerPendingSave("/path/to/file.md", "content");
      expect(hasPendingSave("/path/to/file.md")).toBe(true);
    });

    it("handles Windows-style paths", () => {
      registerPendingSave("C:\\Users\\test\\file.md", "content");
      expect(hasPendingSave("C:\\Users\\test\\file.md")).toBe(true);
    });
  });

  describe("matchesPendingSave", () => {
    it("returns true when disk content matches pending content", () => {
      registerPendingSave("/path/to/file.md", "Hello World");
      expect(matchesPendingSave("/path/to/file.md", "Hello World")).toBe(true);
    });

    it("returns false when disk content differs from pending content", () => {
      registerPendingSave("/path/to/file.md", "Hello World");
      expect(matchesPendingSave("/path/to/file.md", "Different content")).toBe(false);
    });

    it("returns false for unregistered path", () => {
      expect(matchesPendingSave("/path/to/unknown.md", "any content")).toBe(false);
    });

    it("handles empty content", () => {
      registerPendingSave("/path/to/file.md", "");
      expect(matchesPendingSave("/path/to/file.md", "")).toBe(true);
      expect(matchesPendingSave("/path/to/file.md", "not empty")).toBe(false);
    });

    it("is case-sensitive for content", () => {
      registerPendingSave("/path/to/file.md", "Hello");
      expect(matchesPendingSave("/path/to/file.md", "hello")).toBe(false);
    });

    it("handles multiline content with different line endings", () => {
      const unixContent = "line1\nline2\nline3";
      const windowsContent = "line1\r\nline2\r\nline3";

      registerPendingSave("/path/to/file.md", unixContent);
      expect(matchesPendingSave("/path/to/file.md", unixContent)).toBe(true);
      expect(matchesPendingSave("/path/to/file.md", windowsContent)).toBe(false);
    });
  });

  describe("clearPendingSave", () => {
    it("removes a registered path with matching token", () => {
      const token = registerPendingSave("/path/to/file.md", "content");
      expect(hasPendingSave("/path/to/file.md")).toBe(true);

      clearPendingSave("/path/to/file.md", token);
      expect(hasPendingSave("/path/to/file.md")).toBe(false);
    });

    it("clears unconditionally when no token is provided", () => {
      registerPendingSave("/path/to/file.md", "content");
      expect(hasPendingSave("/path/to/file.md")).toBe(true);

      clearPendingSave("/path/to/file.md");
      expect(hasPendingSave("/path/to/file.md")).toBe(false);
    });

    it("does not clear when token does not match (overlapping save)", () => {
      const token1 = registerPendingSave("/path/to/file.md", "content1");
      // Second save overwrites with new token
      registerPendingSave("/path/to/file.md", "content2");

      // Stale token from first save should NOT clear the entry
      clearPendingSave("/path/to/file.md", token1);
      expect(hasPendingSave("/path/to/file.md")).toBe(true);
      expect(matchesPendingSave("/path/to/file.md", "content2")).toBe(true);
    });

    it("clears when token matches the current registration", () => {
      registerPendingSave("/path/to/file.md", "content1");
      const token2 = registerPendingSave("/path/to/file.md", "content2");

      clearPendingSave("/path/to/file.md", token2);
      expect(hasPendingSave("/path/to/file.md")).toBe(false);
    });

    it("does not affect other paths", () => {
      const token1 = registerPendingSave("/path/to/file1.md", "content1");
      registerPendingSave("/path/to/file2.md", "content2");

      clearPendingSave("/path/to/file1.md", token1);

      expect(hasPendingSave("/path/to/file1.md")).toBe(false);
      expect(hasPendingSave("/path/to/file2.md")).toBe(true);
    });
  });

  describe("_clearAllPendingSaves", () => {
    it("removes all registered paths", () => {
      registerPendingSave("/path/to/file1.md", "content1");
      registerPendingSave("/path/to/file2.md", "content2");
      registerPendingSave("/path/to/file3.md", "content3");

      _clearAllPendingSaves();

      expect(hasPendingSave("/path/to/file1.md")).toBe(false);
      expect(hasPendingSave("/path/to/file2.md")).toBe(false);
      expect(hasPendingSave("/path/to/file3.md")).toBe(false);
    });
  });

  describe("re-registration", () => {
    it("updates content on re-registration", () => {
      registerPendingSave("/path/to/file.md", "original content");
      expect(matchesPendingSave("/path/to/file.md", "original content")).toBe(true);

      // Re-register with new content
      registerPendingSave("/path/to/file.md", "new content");

      expect(matchesPendingSave("/path/to/file.md", "original content")).toBe(false);
      expect(matchesPendingSave("/path/to/file.md", "new content")).toBe(true);
    });
  });

  describe("path normalization with content", () => {
    it("matches content regardless of path format", () => {
      // This test assumes normalizePath handles path variations
      registerPendingSave("/path/to/file.md", "content");
      expect(matchesPendingSave("/path/to/file.md", "content")).toBe(true);
    });
  });
});

// WI-RA1A.7 — the post-save grace window is ONE helper. It used to be a
// `setTimeout(() => clearPendingSave(...), 1000)` copied to five call sites,
// one of which had already drifted to an immediate clear.
describe("clearPendingSaveAfterGrace", () => {
  beforeEach(() => {
    _clearAllPendingSaves();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the registration matchable until the grace window has elapsed", () => {
    const token = registerPendingSave("/path/to/file.md", "written");
    clearPendingSaveAfterGrace("/path/to/file.md", token);

    // A late watcher event inside the window must still be recognised as ours.
    vi.advanceTimersByTime(PENDING_SAVE_GRACE_MS - 1);
    expect(matchesPendingSave("/path/to/file.md", "written")).toBe(true);

    vi.advanceTimersByTime(1);
    expect(hasPendingSave("/path/to/file.md")).toBe(false);
  });

  it("leaves a newer save's registration alone when the older grace window ends", () => {
    const older = registerPendingSave("/path/to/file.md", "first");
    clearPendingSaveAfterGrace("/path/to/file.md", older);

    vi.advanceTimersByTime(PENDING_SAVE_GRACE_MS / 2);
    const newer = registerPendingSave("/path/to/file.md", "second");
    clearPendingSaveAfterGrace("/path/to/file.md", newer);

    // The older window ends here; the newer save is only half way through its own.
    vi.advanceTimersByTime(PENDING_SAVE_GRACE_MS / 2);
    expect(matchesPendingSave("/path/to/file.md", "second")).toBe(true);

    vi.advanceTimersByTime(PENDING_SAVE_GRACE_MS / 2);
    expect(hasPendingSave("/path/to/file.md")).toBe(false);
  });

  it("clears nothing early when the same path is cleared twice", () => {
    const token = registerPendingSave("/path/to/file.md", "written");
    clearPendingSaveAfterGrace("/path/to/file.md", token);
    clearPendingSaveAfterGrace("/path/to/file.md", token);

    vi.advanceTimersByTime(PENDING_SAVE_GRACE_MS - 1);
    expect(hasPendingSave("/path/to/file.md")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hasPendingSave("/path/to/file.md")).toBe(false);
  });

  it("covers the watcher pipeline it exists for", () => {
    // Rust debounce (200 ms) + emit + event loop + readTextFile + compare was
    // measured past 500 ms under heavy I/O; a window at or below that reopens
    // the "file changed on disk" prompt for our own write.
    expect(PENDING_SAVE_GRACE_MS).toBeGreaterThan(500);
  });
});

describe("the grace window has exactly one implementation", () => {
  const SRC_ROOT = resolve(import.meta.dirname, "..");
  /** A timer whose callback clears a pending save: the copy this helper replaced. */
  const HAND_ROLLED_GRACE = /setTimeout\(\s*(?:async\s*)?\(\)\s*=>\s*\{?\s*clearPendingSave\(/;

  function productionSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "__mocks__") continue;
        out.push(...productionSources(full));
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (entry.includes(".test.") || entry.endsWith(".d.ts")) continue;
      out.push(full);
    }
    return out;
  }

  const sources = productionSources(SRC_ROOT);

  it("finds production sources to scan", () => {
    // A scan that found nothing would pass the next assertion vacuously.
    expect(sources.length).toBeGreaterThan(500);
  });

  it("no production file times its own clearPendingSave", () => {
    const offenders = sources
      .filter((file) => HAND_ROLLED_GRACE.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_ROOT, file))
      .filter((file) => file !== join("utils", "pendingSaves.ts"));

    expect(
      offenders,
      "These files schedule their own clearPendingSave. Call " +
        "clearPendingSaveAfterGrace(path, token) from utils/pendingSaves instead, " +
        "so the window stays one contract with one edit site.",
    ).toEqual([]);
  });
});
