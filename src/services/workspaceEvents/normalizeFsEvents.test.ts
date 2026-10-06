// @vitest-environment node
import { describe, expect, it } from "vitest";

import { normalizeFsBatch, normalizeFsEvents, type NormalizeDeps } from "./normalizeFsEvents";
import type { RawFsChangeBatch, RawFsChangeEvent } from "./types";

const ROOT = "/ws";
const WIN = "main";

function deps(over: Partial<NormalizeDeps> = {}): NormalizeDeps {
  return {
    windowLabel: WIN,
    rootPath: ROOT,
    normalizePath: (p) => p,
    hasPendingSave: () => false,
    ...over,
  };
}

function raw(over: Partial<RawFsChangeEvent> = {}): RawFsChangeEvent {
  return { watchId: WIN, rootPath: ROOT, paths: [`${ROOT}/a.md`], kind: "modify", ...over };
}

describe("normalizeFsEvents", () => {
  it("drops events from another window (watchId mismatch)", () => {
    expect(normalizeFsEvents(raw({ watchId: "other" }), deps())).toEqual([]);
  });

  it("drops events when not in workspace mode (null root)", () => {
    expect(normalizeFsEvents(raw(), deps({ rootPath: null }))).toEqual([]);
  });

  it("drops events with no paths", () => {
    expect(normalizeFsEvents(raw({ paths: [] }), deps())).toEqual([]);
  });

  it.each([
    ["create", "created"],
    ["modify", "modified"],
    ["remove", "deleted"],
    ["rename", "renamed"],
  ])("classifies raw kind %s as %s", (rawKind, expected) => {
    const [evt] = normalizeFsEvents(raw({ kind: rawKind }), deps());
    expect(evt.kind).toBe(expected);
  });

  it("treats an unknown kind as modified (never drops a real edit)", () => {
    const [evt] = normalizeFsEvents(raw({ kind: "weird" }), deps());
    expect(evt.kind).toBe("modified");
  });

  it("scopes out paths outside the workspace root (boundary-safe)", () => {
    const evts = normalizeFsEvents(
      raw({ paths: [`${ROOT}/in.md`, "/wsother/out.md", "/elsewhere.md"] }),
      deps(),
    );
    expect(evts.map((e) => e.path)).toEqual([`${ROOT}/in.md`]);
  });

  it("includes the root itself as in-scope", () => {
    const [evt] = normalizeFsEvents(raw({ paths: [ROOT] }), deps());
    expect(evt.path).toBe(ROOT);
  });

  it("flags self-writes via hasPendingSave", () => {
    const [evt] = normalizeFsEvents(
      raw({ paths: [`${ROOT}/a.md`] }),
      deps({ hasPendingSave: (p) => p === `${ROOT}/a.md` }),
    );
    expect(evt.selfWrite).toBe(true);
  });

  it("does not flag an external edit as a self-write", () => {
    const [evt] = normalizeFsEvents(raw(), deps());
    expect(evt.selfWrite).toBe(false);
  });

  it("dedups repeated paths within one event", () => {
    const evts = normalizeFsEvents(raw({ paths: [`${ROOT}/a.md`, `${ROOT}/a.md`] }), deps());
    expect(evts).toHaveLength(1);
  });

  it("normalizes paths (and the root) via the injected normalizer", () => {
    const [evt] = normalizeFsEvents(
      raw({ paths: [`${ROOT}/A.MD`] }),
      deps({ normalizePath: (p) => p.toLowerCase() }),
    );
    expect(evt.path).toBe(`${ROOT.toLowerCase()}/a.md`);
    expect(evt.rootPath).toBe(ROOT.toLowerCase());
  });

  describe("renames (flattened [old, new] pairs)", () => {
    it("emits a renamed event carrying the previous path", () => {
      const [evt] = normalizeFsEvents(
        raw({ kind: "rename", paths: [`${ROOT}/old.md`, `${ROOT}/new.md`] }),
        deps(),
      );
      expect(evt).toMatchObject({
        kind: "renamed",
        path: `${ROOT}/new.md`,
        previousPath: `${ROOT}/old.md`,
      });
    });

    it("keeps a rename out of the workspace (old path in scope) so consumers react", () => {
      const [evt] = normalizeFsEvents(
        raw({ kind: "rename", paths: [`${ROOT}/old.md`, "/elsewhere/new.md"] }),
        deps(),
      );
      expect(evt).toMatchObject({
        kind: "renamed",
        path: "/elsewhere/new.md",
        previousPath: `${ROOT}/old.md`,
      });
    });

    it("drops a rename with both endpoints out of scope", () => {
      const evts = normalizeFsEvents(
        raw({ kind: "rename", paths: ["/a/old.md", "/b/new.md"] }),
        deps(),
      );
      expect(evts).toEqual([]);
    });

    it("emits an unpaired trailing rename path without a previousPath", () => {
      const [evt] = normalizeFsEvents(raw({ kind: "rename", paths: [`${ROOT}/only.md`] }), deps());
      expect(evt).toMatchObject({ kind: "renamed", path: `${ROOT}/only.md` });
      expect(evt.previousPath).toBeUndefined();
    });

    it("handles multiple rename pairs", () => {
      const evts = normalizeFsEvents(
        raw({ kind: "rename", paths: [`${ROOT}/a`, `${ROOT}/b`, `${ROOT}/c`, `${ROOT}/d`] }),
        deps(),
      );
      expect(evts.map((e) => [e.previousPath, e.path])).toEqual([
        [`${ROOT}/a`, `${ROOT}/b`],
        [`${ROOT}/c`, `${ROOT}/d`],
      ]);
    });
  });
});

// WI-RA11.1 — the watcher delivers one batch per window of time, and says so
// when it lost track of the tree.
describe("normalizeFsBatch", () => {
  function batch(over: Partial<RawFsChangeBatch> = {}): RawFsChangeBatch {
    return { watchId: WIN, rootPath: ROOT, changes: [], rescan: false, ...over };
  }

  it("returns nothing for an empty batch", () => {
    expect(normalizeFsBatch(batch(), deps())).toEqual([]);
  });

  it("keeps every change of a batch, in the order the watcher reported them", () => {
    const evts = normalizeFsBatch(
      batch({
        changes: [
          { kind: "create", paths: [`${ROOT}/a.md`] },
          { kind: "remove", paths: [`${ROOT}/a.md`] },
          { kind: "create", paths: [`${ROOT}/a.md`] },
          { kind: "modify", paths: [`${ROOT}/笔记.md`] },
        ],
      }),
      deps(),
    );
    expect(evts.map((e) => [e.kind, e.path])).toEqual([
      ["created", `${ROOT}/a.md`],
      ["deleted", `${ROOT}/a.md`],
      ["created", `${ROOT}/a.md`],
      ["modified", `${ROOT}/笔记.md`],
    ]);
  });

  it("never pairs two single-path renames that merely share a batch", () => {
    // FSEvents reports each end of a rename on its own; joining them into one
    // [old, new] pair would re-point a tab at an unrelated file.
    const evts = normalizeFsBatch(
      batch({
        changes: [
          { kind: "rename", paths: [`${ROOT}/a.md`] },
          { kind: "rename", paths: [`${ROOT}/b.md`] },
        ],
      }),
      deps(),
    );
    expect(evts).toEqual([
      { kind: "renamed", path: `${ROOT}/a.md`, rootPath: ROOT, selfWrite: false },
      { kind: "renamed", path: `${ROOT}/b.md`, rootPath: ROOT, selfWrite: false },
    ]);
  });

  it("keeps a reported [old, new] pair as one rename", () => {
    const evts = normalizeFsBatch(
      batch({ changes: [{ kind: "rename", paths: [`${ROOT}/old.md`, `${ROOT}/new.md`] }] }),
      deps(),
    );
    expect(evts).toEqual([
      { kind: "renamed", path: `${ROOT}/new.md`, previousPath: `${ROOT}/old.md`, rootPath: ROOT, selfWrite: false },
    ]);
  });

  it("scopes each change to the workspace root", () => {
    const evts = normalizeFsBatch(
      batch({
        changes: [
          { kind: "modify", paths: ["/elsewhere/a.md"] },
          { kind: "modify", paths: [`${ROOT}/in.md`] },
        ],
      }),
      deps(),
    );
    expect(evts.map((e) => e.path)).toEqual([`${ROOT}/in.md`]);
  });

  it("flags a self-write inside a batch", () => {
    const [evt] = normalizeFsBatch(
      batch({ changes: [{ kind: "modify", paths: [`${ROOT}/a.md`] }] }),
      deps({ hasPendingSave: (p) => p === `${ROOT}/a.md` }),
    );
    expect(evt.selfWrite).toBe(true);
  });

  it("turns the watcher's rescan flag into one rescan event for the root", () => {
    expect(normalizeFsBatch(batch({ rescan: true }), deps())).toEqual([
      { kind: "rescan", path: ROOT, rootPath: ROOT, selfWrite: false },
    ]);
  });

  it("delivers the changes of a batch ahead of its rescan", () => {
    const evts = normalizeFsBatch(
      batch({ rescan: true, changes: [{ kind: "modify", paths: [`${ROOT}/a.md`] }] }),
      deps(),
    );
    expect(evts.map((e) => e.kind)).toEqual(["modified", "rescan"]);
  });

  it("drops a batch from another window, rescan included", () => {
    expect(
      normalizeFsBatch(
        batch({ watchId: "other", rescan: true, changes: [{ kind: "modify", paths: [`${ROOT}/a.md`] }] }),
        deps(),
      ),
    ).toEqual([]);
  });

  it("drops everything when the window has no watch root", () => {
    expect(normalizeFsBatch(batch({ rescan: true }), deps({ rootPath: null }))).toEqual([]);
  });

  it("ignores a rescan for a root this window no longer watches", () => {
    expect(normalizeFsBatch(batch({ rootPath: "/previous", rescan: true }), deps())).toEqual([]);
  });

  it("compares the rescan root after normalization", () => {
    const evts = normalizeFsBatch(
      batch({ rootPath: "C:\\ws", rescan: true }),
      deps({ rootPath: "C:/ws", normalizePath: (p) => p.replace(/\\/g, "/") }),
    );
    expect(evts).toEqual([{ kind: "rescan", path: "C:/ws", rootPath: "C:/ws", selfWrite: false }]);
  });

  it.each([
    ["a null payload", null],
    ["changes that are not a list", { watchId: WIN, rootPath: ROOT, changes: "nope", rescan: false }],
    ["a change that is not an object", { watchId: WIN, rootPath: ROOT, changes: [null, 7], rescan: false }],
    ["a change without paths", { watchId: WIN, rootPath: ROOT, changes: [{ kind: "modify" }], rescan: false }],
    ["a rescan flag that is not a boolean", { watchId: WIN, rootPath: ROOT, changes: [], rescan: "yes" }],
  ])("never throws on %s", (_name, payload) => {
    expect(normalizeFsBatch(payload as unknown as RawFsChangeBatch, deps())).toEqual([]);
  });
});
