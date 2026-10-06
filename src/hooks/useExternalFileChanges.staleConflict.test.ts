/**
 * When a queued conflict has gone stale.
 *
 * A dirty-file conflict is not resolved where it is detected. It is queued,
 * debounced for 300 ms, and — for a multi-file batch — put behind a modal the
 * user may sit on indefinitely. The entry names the tab and path captured when
 * it was QUEUED, and in that window the tab can be closed, saved or renamed.
 *
 * The decision itself is pure and unit-tested as `isQueuedConflictStillLive`
 * (`utils/openPolicy.test.ts`), which is where the four cases live as four
 * assertions. These are the other half: proof that the hook actually CONSULTS
 * it. A filter that is never called looks exactly like one that passes
 * everything, and only an end-to-end assertion can tell those apart.
 *
 * Also here: the "Keep my changes" refresh (issue 904) — after Keep, an
 * identical follow-up disk touch must queue no conflict at all. Its debounce is
 * driven on a fake clock, so "nothing was queued" is observed, not slept on.
 *
 * Split from `useExternalFileChanges.test.ts`, which is size-baselined and full.
 *
 * WI-RA14A.2 — the debounce waits run on a fake clock, not wall-clock sleeps.
 *
 * @coordinates-with utils/openPolicy/externalChangePolicy.ts — the predicate
 * @module hooks/useExternalFileChanges.staleConflict.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fileBytes } from "@/test/fileBytes";
import { renderHook } from "@testing-library/react";

// --- Hoisted mocks ---
const mocks = vi.hoisted(() => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  readTextFile: vi.fn(),
  exists: vi.fn(async () => true),
  toastInfo: vi.fn(),
  matchesPendingSave: vi.fn(() => false),
  hasPendingSave: vi.fn(() => false),
  dialogMessage: vi.fn(),
  dialogSave: vi.fn(),
  saveToPath: vi.fn(),
  reloadTabFromDisk: vi.fn(),
  activeScopeRoot: vi.fn(() => null as string | null),
  subscribeWorkspaceEvents: vi.fn((_label: string, _cb: unknown) => () => {}),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: (path: string) => fileBytes(mocks.readTextFile(path)),
  exists: mocks.exists,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: mocks.dialogMessage,
  save: mocks.dialogSave,
}));

vi.mock("sonner", () => ({
  toast: {
    info: mocks.toastInfo,
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/services/ime/imeToast", () => ({
  imeToast: {
    info: mocks.toastInfo,
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/contexts/WindowContext", () => ({
  useWindowLabel: vi.fn(() => "main"),
}));

vi.mock("@/utils/pendingSaves", () => ({
  matchesPendingSave: mocks.matchesPendingSave,
  hasPendingSave: mocks.hasPendingSave,
}));

vi.mock("@/services/persistence/saveToPath", () => ({
  saveToPath: mocks.saveToPath,
}));

vi.mock("@/services/persistence/reloadFromDisk", () => ({
  reloadTabFromDisk: mocks.reloadTabFromDisk,
}));

vi.mock("@/services/workspaces/activeWorkspaceScope", () => ({
  getActiveWorkspaceScope: vi.fn(() => ({ rootPath: mocks.activeScopeRoot() })),
}));

vi.mock("@/services/workspaceEvents/subscribeWorkspaceEvents", () => ({
  subscribeWorkspaceEvents: mocks.subscribeWorkspaceEvents,
}));

import { useDocumentStore } from "@/stores/documentStore";
import {
  seedTabAndDocument,
  type SeedOptions,
} from "@/test/externalFileChangesFixtures";
import { useExternalFileChanges } from "./useExternalFileChanges";

type ListenCallback = (event: { payload: { watchId: string; rootPath: string; paths: string[]; kind: string } }) => Promise<void>;

const seedStores = (overrides: SeedOptions = {}) => seedTabAndDocument(overrides);

/** Map a raw fs:changed payload to the SemanticWorkspaceEvent[] the bus delivers. */
function toSemantic(payload: { rootPath: string; paths: string[]; kind: string }) {
  const { kind, paths, rootPath } = payload;
  if (kind === "rename") {
    const events = [];
    for (let i = 0; i < paths.length; i += 2) {
      const paired = i + 1 < paths.length;
      events.push({
        kind: "renamed" as const,
        path: paired ? paths[i + 1] : paths[i],
        previousPath: paired ? paths[i] : undefined,
        rootPath,
        selfWrite: false,
      });
    }
    return events;
  }
  const k: "created" | "deleted" | "modified" =
    kind === "create" ? "created" : kind === "remove" ? "deleted" : "modified";
  return paths.map((p) => ({ kind: k, path: p, rootPath, selfWrite: false }));
}

/**
 * Compat shim: the hook now subscribes to the workspace event source instead of
 * `listen("fs:changed")`. This wraps the captured subscriber so existing tests
 * keep firing the historical raw payload — it emulates the watchId scoping the
 * source now owns, converts raw → semantic, delivers to the hook, and awaits the
 * async routing so `await callback(payload)` still means "effects applied".
 */
function captureListenCallback(): ListenCallback {
  const calls = mocks.subscribeWorkspaceEvents.mock.calls as unknown as unknown[][];
  const call = calls.find((c) => typeof c[1] === "function");
  if (!call) throw new Error("subscribeWorkspaceEvents was not called");
  const listener = call[1] as (events: unknown[]) => void;
  return async ({ payload }) => {
    if (payload.watchId !== "main") return; // the source scopes by watchId
    const activeRoot = mocks.activeScopeRoot();
    if (activeRoot && payload.rootPath !== activeRoot) return; // …and by the watched root
    listener(toSemantic(payload));
    // One macrotask turn for the async routing, advanced on the fake clock
    // every case runs under.
    await vi.advanceTimersByTimeAsync(0);
  };
}

/** Render hook, wait for the subscription, and return the compat callback. */
async function setupHookAndCallback(): Promise<ListenCallback> {
  renderHook(() => useExternalFileChanges());
  await vi.waitFor(() => expect(mocks.subscribeWorkspaceEvents).toHaveBeenCalled());
  return captureListenCallback();
}

// Reset between tests. The split that created this file left the mocks
// accumulating across cases, which showed up as a call count of 6 where 2 were
// expected — a suite that is measuring the previous test as well as its own.
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockImplementation(() => Promise.resolve(() => {}));
  mocks.subscribeWorkspaceEvents.mockImplementation(
    (_label: string, _cb: unknown) => () => {},
  );
  mocks.activeScopeRoot.mockReturnValue(null);
  mocks.matchesPendingSave.mockReturnValue(false);
  mocks.hasPendingSave.mockReturnValue(false);
  useDocumentStore.setState({ documents: {} });
});

/** The debounce the hook queues dirty conflicts behind. */
const BATCH_DEBOUNCE_MS = 300;

describe("a queued conflict that went stale is not resolved", () => {
  // The queue's debounce is a real `setTimeout`; faking it lets each case
  // advance exactly past the debounce instead of sleeping and hoping it fired.
  // Faked from the start so the debounce is scheduled on the fake clock.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Audit finding #27. An entry names the tab and path captured when it was
  // QUEUED, then waits out a 300 ms debounce (and, for a multi-file batch, a
  // modal the user may sit on). The decision logic is unit-tested as
  // `isQueuedConflictStillLive`; these assert the hook actually consults it,
  // because a filter that is never called looks exactly like one that passes.
  it("does not prompt for a conflict whose tab closed during the debounce", async () => {
    seedStores({ isDirty: true });
    mocks.readTextFile.mockResolvedValue("# external change");

    const callback = await setupHookAndCallback();
    await callback({
      payload: {
        watchId: "main",
        rootPath: "/workspace",
        paths: ["/workspace/test.md"],
        kind: "modify",
      },
    });

    // The conflict is queued: its debounce is the pending timer.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    useDocumentStore.setState({ documents: {} });
    await vi.advanceTimersByTimeAsync(BATCH_DEBOUNCE_MS);

    // The debounce fired and the batch ran — and asked nothing.
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.dialogMessage).not.toHaveBeenCalled();
  });

  it("does not prompt for a conflict the user saved during the debounce", async () => {
    seedStores({ isDirty: true });
    mocks.readTextFile.mockResolvedValue("# external change");

    const callback = await setupHookAndCallback();
    await callback({
      payload: {
        watchId: "main",
        rootPath: "/workspace",
        paths: ["/workspace/test.md"],
        kind: "modify",
      },
    });

    // Saved while queued: the conflict resolved itself, and prompting would
    // ask the user about something that is no longer true.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    seedStores({ isDirty: false });
    await vi.advanceTimersByTimeAsync(BATCH_DEBOUNCE_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.dialogMessage).not.toHaveBeenCalled();
  });
});

// Audit finding #26. Each delivery of events spawned an UNAWAITED
// `handleSemanticBatch`, so two changes arriving close together ran their disk
// reads concurrently. Reads do not finish in the order they start — a larger
// file, a cold cache, a network volume — so the EARLIER batch could land last
// and write content the user had already superseded. The symptom is a document
// that silently reverts to a version that was on disk moments ago.
describe("batches are serialized, so an older read cannot land last", () => {
  // On the fake clock like the rest of the file: the settle after each batch
  // is advanced, not slept through.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves the NEWER content in the document when reads finish out of order", async () => {
    seedStores();

    // First read resolves slowly, second immediately.
    let releaseFirst!: (text: string) => void;
    mocks.readTextFile
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => { releaseFirst = resolve; }),
      )
      .mockResolvedValue("# second (newer)");

    const callback = await setupHookAndCallback();
    const event = {
      payload: {
        watchId: "main",
        rootPath: "/workspace",
        paths: ["/workspace/test.md"],
        kind: "modify",
      },
    };

    // Deliver the first change and wait until its read is genuinely in flight.
    const first = callback(event);
    await vi.waitFor(() => expect(mocks.readTextFile).toHaveBeenCalledTimes(1));

    // The second change is delivered while the first read is still pending —
    // that overlap is the whole scenario.
    const second = callback(event);
    releaseFirst("# first (older)");
    await first;
    await second;
    await vi.advanceTimersByTimeAsync(50);

    expect(useDocumentStore.getState().documents["tab-1"]?.content)
      .toBe("# second (newer)");
  });

  it("still processes every batch", async () => {
    // Serializing must not drop work — the point is ordering, not exclusion.
    seedStores();
    mocks.readTextFile.mockResolvedValue("# changed");

    const callback = await setupHookAndCallback();
    const event = (path: string) => ({
      payload: { watchId: "main", rootPath: "/workspace", paths: [path], kind: "modify" },
    });

    await callback(event("/workspace/test.md"));
    await callback(event("/workspace/test.md"));
    await vi.advanceTimersByTimeAsync(50);

    expect(mocks.readTextFile).toHaveBeenCalledTimes(2);
  });
});

// Regression for issue 904: OneDrive (and other cloud sync daemons) keep
// touching the file in the background even when the user has "paused" sync.
// With a dirty doc, that triggers the external-change dialog. The user picks
// "Keep my changes" → divergent → auto-save paused. The bug: lastDiskContent
// was not refreshed after Keep, so every subsequent identical disk touch
// fires the dialog AGAIN — user is stuck in a loop until they manually save.
//
// Fix: after Keep, re-read disk and adopt that content as lastDiskContent so
// the soft-equals guard silently no-ops identical follow-up touches.
describe("useExternalFileChanges — Keep my changes refreshes lastDiskContent", () => {
  // Fake clock: the follow-up must be shown to queue NOTHING, which a sleep
  // past the debounce can only hope to observe.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adopts current disk content as lastDiskContent after Keep, suppressing follow-up dialogs", async () => {
    seedStores({ isDirty: true, lastDiskContent: "# old content" });

    // First fs:changed: disk has a OneDrive-rewritten version.
    mocks.readTextFile.mockResolvedValueOnce("# rewritten by onedrive");
    // User picks "Keep my changes" (Cancel button on the 3-way dialog).
    mocks.dialogMessage.mockResolvedValueOnce("Cancel");
    // Re-read inside handleDirtyChange returns the same rewritten content.
    mocks.readTextFile.mockResolvedValueOnce("# rewritten by onedrive");

    const callback = await setupHookAndCallback();

    await callback({
      payload: {
        watchId: "main",
        rootPath: "/workspace",
        paths: ["/workspace/test.md"],
        kind: "modify",
      },
    });
    // Let the debounce batch run.
    await vi.advanceTimersByTimeAsync(BATCH_DEBOUNCE_MS);
    await vi.waitFor(() => expect(mocks.dialogMessage).toHaveBeenCalledTimes(1));
    // And the post-dialog re-read.
    await vi.waitFor(() => expect(mocks.readTextFile).toHaveBeenCalledTimes(2));

    const doc = useDocumentStore.getState().documents["tab-1"];
    expect(doc?.isDivergent).toBe(true);
    // Critical: lastDiskContent now reflects the OneDrive-rewritten content,
    // so an identical follow-up rewrite is invisible to the soft-equals guard.
    expect(doc?.lastDiskContent).toBe("# rewritten by onedrive");

    // Second fs:changed for the SAME rewritten content — must NOT prompt.
    mocks.readTextFile.mockResolvedValueOnce("# rewritten by onedrive");
    mocks.dialogMessage.mockClear();

    await callback({
      payload: {
        watchId: "main",
        rootPath: "/workspace",
        paths: ["/workspace/test.md"],
        kind: "modify",
      },
    });
    // Soft-equals matches → silent no-op: nothing is queued behind the
    // debounce, and running the clock past it re-fires no dialog.
    expect(mocks.readTextFile).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(BATCH_DEBOUNCE_MS);
    expect(mocks.dialogMessage).not.toHaveBeenCalled();
  });

  it("tolerates disk-read failure during the post-Keep refresh", async () => {
    seedStores({ isDirty: true, lastDiskContent: "# old content" });

    mocks.readTextFile.mockResolvedValueOnce("# rewritten by onedrive");
    mocks.dialogMessage.mockResolvedValueOnce("Cancel");
    // Refresh read fails — must not crash the handler.
    mocks.readTextFile.mockRejectedValueOnce(new Error("EBUSY"));

    const callback = await setupHookAndCallback();

    await callback({
      payload: {
        watchId: "main",
        rootPath: "/workspace",
        paths: ["/workspace/test.md"],
        kind: "modify",
      },
    });
    await vi.waitFor(() =>
      expect(mocks.readTextFile).toHaveBeenCalledTimes(2),
    );

    // Divergent is still set; lastDiskContent simply stays at the value from
    // the initial dialog read (worst case: prompt re-fires on the next event).
    const doc = useDocumentStore.getState().documents["tab-1"];
    expect(doc?.isDivergent).toBe(true);
  });
});
