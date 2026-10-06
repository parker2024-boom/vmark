// @vitest-environment node
// WI-RA10A.13 — the history queue orders operations per document, and lets a
// whole-store operation exclude everything else.
import { describe, it, expect } from "vitest";
import {
  pendingHistoryCount,
  serializeAllHistories,
  serializeHistory,
} from "./historyQueue";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-runnable continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** A task that records when it starts and ends, and ends when told to. */
function tracked(log: string[], name: string, gate: Deferred) {
  return async () => {
    log.push(`${name}:start`);
    await gate.promise;
    log.push(`${name}:end`);
    return name;
  };
}

describe("serializeHistory", () => {
  it("runs operations on one document in submission order, one at a time", async () => {
    const log: string[] = [];
    const first = deferred();
    const second = deferred();

    const a = serializeHistory("/doc.md", tracked(log, "a", first));
    const b = serializeHistory("/doc.md", tracked(log, "b", second));
    await settle();
    expect(log).toEqual(["a:start"]);

    // Releasing the second task's gate first must not let it overtake.
    second.resolve();
    await settle();
    expect(log).toEqual(["a:start"]);

    first.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("starts nothing synchronously, even on an idle queue", () => {
    const log: string[] = [];
    const gate = deferred();
    gate.resolve();

    const done = serializeHistory("/idle.md", tracked(log, "a", gate));

    expect(log).toEqual([]);
    return done;
  });

  it("lets different documents run at the same time", async () => {
    const log: string[] = [];
    const first = deferred();
    const second = deferred();

    const a = serializeHistory("/one.md", tracked(log, "a", first));
    const b = serializeHistory("/two.md", tracked(log, "b", second));
    await settle();
    expect(log).toEqual(["a:start", "b:start"]);

    second.resolve();
    await b;
    expect(log).toEqual(["a:start", "b:start", "b:end"]);
    first.resolve();
    await a;
  });

  it("treats paths as opaque keys: a different spelling is a different history", async () => {
    // The history directory is the hash of the path as given, so these two are
    // different directories and must not wait for each other.
    const log: string[] = [];
    const first = deferred();
    const second = deferred();

    const a = serializeHistory("/dir/doc.md", tracked(log, "a", first));
    const b = serializeHistory("/dir/./doc.md", tracked(log, "b", second));
    await settle();
    expect(log).toEqual(["a:start", "b:start"]);

    first.resolve();
    second.resolve();
    await Promise.all([a, b]);
  });

  it("hands back the task's own rejection and still runs the next one", async () => {
    const log: string[] = [];
    const first = deferred();
    const second = deferred();

    const a = serializeHistory("/doc.md", tracked(log, "a", first));
    const b = serializeHistory("/doc.md", tracked(log, "b", second));
    first.reject(new Error("disk full"));
    second.resolve();

    await expect(a).rejects.toThrow("disk full");
    await expect(b).resolves.toBe("b");
    expect(log).toEqual(["a:start", "b:start", "b:end"]);
  });

  it("turns a task that throws synchronously into a rejection, not a wedge", async () => {
    const failing = serializeHistory("/doc.md", () => {
      throw new Error("bad index");
    });
    const next = serializeHistory("/doc.md", async () => "ran");

    await expect(failing).rejects.toThrow("bad index");
    await expect(next).resolves.toBe("ran");
  });

  it("forgets a document once its work has settled", async () => {
    const gate = deferred();
    const a = serializeHistory("/doc.md", tracked([], "a", gate));
    expect(pendingHistoryCount()).toBe(1);

    gate.resolve();
    await a;
    await settle();
    expect(pendingHistoryCount()).toBe(0);
  });

  it("keeps the entry of a later submission when an earlier one settles", async () => {
    const first = deferred();
    const second = deferred();
    const a = serializeHistory("/doc.md", tracked([], "a", first));
    const b = serializeHistory("/doc.md", tracked([], "b", second));

    first.resolve();
    await a;
    await settle();
    expect(pendingHistoryCount()).toBe(1);

    second.resolve();
    await b;
    await settle();
    expect(pendingHistoryCount()).toBe(0);
  });
});

describe("serializeAllHistories", () => {
  it("waits for every operation outstanding on any document", async () => {
    const log: string[] = [];
    const one = deferred();
    const two = deferred();
    const all = deferred();

    const a = serializeHistory("/one.md", tracked(log, "a", one));
    const b = serializeHistory("/two.md", tracked(log, "b", two));
    const clear = serializeAllHistories(tracked(log, "clear", all));
    await settle();
    expect(log).toEqual(["a:start", "b:start"]);

    one.resolve();
    await a;
    await settle();
    expect(log).toEqual(["a:start", "b:start", "a:end"]);

    two.resolve();
    all.resolve();
    await Promise.all([b, clear]);
    expect(log).toEqual(["a:start", "b:start", "a:end", "b:end", "clear:start", "clear:end"]);
  });

  it("holds back every operation submitted after it, on every document", async () => {
    const log: string[] = [];
    const all = deferred();
    const after = deferred();
    after.resolve();

    const clear = serializeAllHistories(tracked(log, "clear", all));
    const a = serializeHistory("/one.md", tracked(log, "a", after));
    const b = serializeHistory("/two.md", tracked(log, "b", after));
    await settle();
    expect(log).toEqual(["clear:start"]);

    all.resolve();
    await Promise.all([clear, a, b]);
    expect(log.slice(0, 2)).toEqual(["clear:start", "clear:end"]);
    expect(log.slice(2).sort()).toEqual(["a:end", "a:start", "b:end", "b:start"]);
  });

  it("keeps per-document order across it", async () => {
    const log: string[] = [];
    const gate = deferred();
    gate.resolve();

    const results = await Promise.all([
      serializeHistory("/doc.md", tracked(log, "before", gate)),
      serializeAllHistories(tracked(log, "clear", gate)),
      serializeHistory("/doc.md", tracked(log, "after-1", gate)),
      serializeHistory("/doc.md", tracked(log, "after-2", gate)),
    ]);

    expect(results).toEqual(["before", "clear", "after-1", "after-2"]);
    expect(log.filter((entry) => entry.endsWith(":start"))).toEqual([
      "before:start",
      "clear:start",
      "after-1:start",
      "after-2:start",
    ]);
  });

  it("orders two whole-store operations", async () => {
    const log: string[] = [];
    const first = deferred();
    const second = deferred();

    const a = serializeAllHistories(tracked(log, "a", first));
    const b = serializeAllHistories(tracked(log, "b", second));
    second.resolve();
    await settle();
    expect(log).toEqual(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("does not wedge the store when it fails", async () => {
    const failing = serializeAllHistories(async () => {
      throw new Error("permission denied");
    });
    const next = serializeHistory("/doc.md", async () => "ran");
    const nextAll = serializeAllHistories(async () => "cleared");

    await expect(failing).rejects.toThrow("permission denied");
    await expect(next).resolves.toBe("ran");
    await expect(nextAll).resolves.toBe("cleared");
  });

  it("is not held up by a failed operation it waited for", async () => {
    const gate = deferred();
    const failing = serializeHistory("/doc.md", tracked([], "a", gate));
    const clear = serializeAllHistories(async () => "cleared");
    gate.reject(new Error("disk full"));

    await expect(failing).rejects.toThrow("disk full");
    await expect(clear).resolves.toBe("cleared");
  });
});
