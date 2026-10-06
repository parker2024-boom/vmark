// WI-RA14C.5 — Tier-0 hot-exit and crash-recovery flow: unsaved work survives
// the process going away.
//
// Two ways a session ends without the user saving, and what must come back:
//   - a coordinated restart (update install): every window answers Rust's
//     capture request, Rust persists the session, the app relaunches and
//     restores it — same tabs, same text, same dirty flags, and a later Save
//     still writes the file in its own line-ending convention;
//   - a hard crash: nothing is captured, so the only record is the periodic
//     recovery snapshot of each dirty document, restored as dirty tabs.
//
// REAL: the production hook composition (`useDocumentResilience` +
// `useResilienceStartup`), the capture payload, schema salvage and migration,
// the restore coordinator, the stores, the recovery writer/reader and the save
// pipeline. FAKED: `@tauri-apps/*` only — the in-memory disk, an event bus,
// and a stand-in for the Rust hot-exit coordinator that does what the real one
// does at this boundary (ask the window for its state, keep the session as
// serialized JSON, hand each window its state back, clear the file when told).
// The "crash" is every store emptied and every hook unmounted; the disk and
// the coordinator's session file are all that survive, as in a real one.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

type Listener = (event: { payload: unknown }) => void;

const tauri = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    listen(event: string, handler: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(handler);
      return Promise.resolve(() => {
        listeners.get(event)?.delete(handler);
      });
    },
    emit(event: string, payload: unknown) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler({ payload });
      return Promise.resolve();
    },
    relaunch: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("@tauri-apps/plugin-fs", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.fsModule();
});
vi.mock("@tauri-apps/api/core", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.coreModule();
});
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen, emit: tauri.emit }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", listen: tauri.listen, emit: tauri.emit }),
  WebviewWindow: { getByLabel: () => Promise.resolve(null) },
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: tauri.relaunch }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
  confirm: vi.fn(),
}));

import { statefulFs } from "@/test/statefulFsFake";
import { WindowContext } from "@/contexts/WindowContext";
import { useDocumentStore } from "@/stores/documentStore";
import { tabFilePath, useTabStore } from "@/stores/tabStore";
import { bootstrapFormats } from "@/lib/formats/registryBootstrap";
import { useDocumentResilience, useResilienceStartup } from "@/hooks/resilience";
import { restartWithHotExit } from "@/services/persistence/hotExit/restartWithHotExit";
import { resetCoordinationState } from "@/services/persistence/hotExit/hotExitCoordination";
import { HOT_EXIT_EVENTS, SCHEMA_VERSION, type WindowState } from "@/services/persistence/hotExit/types";
import { handleSave } from "@/services/files/fileSave";
import { ROOT, WINDOW, doc, editDoc, newUntitledTab, openDocInTab, resetTier0, settle } from "./harness";

const NOTES = `${ROOT}/notes.md`;
const CLEAN = `${ROOT}/clean.md`;
const RECOVERY_DIR = "/Users/test/.config/recovery";
/** A CRLF file, so the restored document must still know its convention. */
const NOTES_ON_DISK = "# 笔记\r\n\r\n第一段。\r\n";
const NOTES_EDITED = "# 笔记\n\n第一段。\n\n未保存的第二段。\n";
const CLEAN_ON_DISK = "# Clean\n\nNothing changed here.\n";
const SCRATCH = "scratch text never saved anywhere\n";

/** What the Rust coordinator keeps between two launches: its session file. */
const rust = {
  sessionFile: null as string | null,
  pending: new Map<string, WindowState>(),
  /** When set, the next launch's restore cannot fetch its window state. */
  failRestore: false,
};

function installRustHotExit(): void {
  statefulFs.stubCommand("hot_exit_capture", async () => {
    const captureId = "capture-1";
    const answered = new Promise<{ state: WindowState }>((resolve) => {
      void tauri.listen(HOT_EXIT_EVENTS.CAPTURE_RESPONSE, (event) => {
        resolve(event.payload as { state: WindowState });
      });
    });
    await tauri.emit(HOT_EXIT_EVENTS.CAPTURE_REQUEST, { capture_id: captureId });
    const { state } = await answered;
    const session = {
      version: SCHEMA_VERSION,
      timestamp: 1_700_000_000,
      vmark_version: "0.0.0-test",
      windows: [state],
      workspace: null,
    };
    rust.sessionFile = JSON.stringify(session); // what reaches the disk is the serialized form
    return JSON.parse(rust.sessionFile);
  });
  statefulFs.stubCommand("hot_exit_inspect_session", () =>
    rust.sessionFile === null ? null : JSON.parse(rust.sessionFile),
  );
  statefulFs.stubCommand("hot_exit_restore", (args) => {
    const session = args.session as { windows: WindowState[] };
    for (const window of session.windows) rust.pending.set(window.window_label, window);
  });
  // Both commands act for the CALLING window (Rust reads it from the IPC
  // message, not from an argument), and every call here comes from WINDOW.
  statefulFs.stubCommand("hot_exit_get_window_state", () => {
    if (rust.failRestore) throw new Error("coordinator unavailable");
    return rust.pending.get(WINDOW) ?? null;
  });
  statefulFs.stubCommand("hot_exit_window_restore_complete", () => {
    rust.pending.delete(WINDOW);
    return rust.pending.size === 0;
  });
  statefulFs.stubCommand("hot_exit_clear_session", () => {
    rust.sessionFile = null;
  });
}

function inWindow({ children }: { children: ReactNode }) {
  return createElement(
    WindowContext.Provider,
    { value: { windowLabel: WINDOW, isDocumentWindow: true } },
    children,
  );
}

/** Start the app's resilience hooks, as the main window mounts them. */
async function launch(): Promise<void> {
  renderHook(
    () => {
      useDocumentResilience();
      useResilienceStartup();
    },
    { wrapper: inWindow },
  );
  await act(async () => {
    await settle(40);
  });
}

/** The process dies: nothing in memory survives; the disk does. */
function crash(): void {
  cleanup();
  tauri.listeners.clear();
  resetCoordinationState();
  useDocumentStore.setState({ documents: {} });
  useTabStore.setState({ tabs: {}, activeTabId: {} });
}

function tabs() {
  return useTabStore.getState().getTabsByWindow(WINDOW);
}

function tabFor(path: string | null, title?: string) {
  const found = tabs().filter((t) => tabFilePath(t) === path && (title === undefined || t.title === title));
  if (found.length !== 1) throw new Error(`expected one tab for ${path ?? title}, found ${found.length}`);
  return found[0];
}

function recoveryFiles(): string[] {
  return statefulFs.paths().filter((p) => p.startsWith(`${RECOVERY_DIR}/`));
}

/** Open the three documents of the session and leave two of them unsaved. */
async function workOnDocuments(): Promise<{ scratchTitle: string }> {
  await openDocInTab(CLEAN, CLEAN_ON_DISK);
  const scratchId = newUntitledTab();
  editDoc(scratchId, SCRATCH);
  const notesId = await openDocInTab(NOTES, NOTES_ON_DISK);
  editDoc(notesId, NOTES_EDITED);
  useTabStore.getState().togglePin(WINDOW, notesId);
  const scratchTitle = useTabStore.getState().findTabById(scratchId)?.title ?? "";
  return { scratchTitle };
}

beforeAll(() => bootstrapFormats());

beforeEach(() => {
  resetTier0();
  resetCoordinationState();
  tauri.listeners.clear();
  tauri.relaunch.mockClear();
  rust.sessionFile = null;
  rust.pending.clear();
  rust.failRestore = false;
  statefulFs.mkdirp("/Users/test/.config");
  installRustHotExit();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Tier-0 hot exit: a coordinated restart brings the session back", () => {
  it("restores every tab with its text and its dirty flag, and clears the session file", async () => {
    await launch();
    const { scratchTitle } = await workOnDocuments();

    await restartWithHotExit();
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
    expect(rust.sessionFile).not.toBeNull();
    crash();
    expect(tabs()).toHaveLength(0);

    await launch();
    await vi.waitFor(() => expect(tabs()).toHaveLength(3));

    const notes = tabFor(NOTES);
    expect(doc(notes.id).content).toBe(NOTES_EDITED);
    expect(doc(notes.id).isDirty).toBe(true);
    expect(notes.isPinned).toBe(true);
    expect(useTabStore.getState().activeTabId[WINDOW]).toBe(notes.id);

    const scratch = tabFor(null, scratchTitle);
    expect(doc(scratch.id).content).toBe(SCRATCH);
    expect(doc(scratch.id).isDirty).toBe(true);

    const clean = tabFor(CLEAN);
    expect(doc(clean.id).content).toBe(CLEAN_ON_DISK);
    expect(doc(clean.id).isDirty).toBe(false);

    // Nothing was written to the user's files by capture or restore…
    expect(statefulFs.read(NOTES)).toBe(NOTES_ON_DISK);
    // …and a restored session is consumed, not replayed on the next launch.
    await vi.waitFor(() => expect(rust.sessionFile).toBeNull());
  });

  it("a restored dirty CRLF document still saves as CRLF", async () => {
    await launch();
    await workOnDocuments();
    await restartWithHotExit();
    crash();
    await launch();
    await vi.waitFor(() => expect(tabs()).toHaveLength(3));
    const notes = tabFor(NOTES);
    useTabStore.getState().setActiveTab(WINDOW, notes.id);

    await handleSave(WINDOW);

    expect(statefulFs.read(NOTES)).toBe(NOTES_EDITED.replace(/\n/g, "\r\n"));
    expect(doc(notes.id).isDirty).toBe(false);
  });

  it("a restore that fails keeps the session file, and the next launch restores from it", async () => {
    await launch();
    await workOnDocuments();
    await restartWithHotExit();
    crash();

    rust.failRestore = true;
    await launch();
    await vi.waitFor(() => expect(rust.pending.size).toBe(1));
    await act(async () => {
      await settle(40);
    });
    expect(tabs().filter((t) => tabFilePath(t) === NOTES)).toHaveLength(0);
    expect(rust.sessionFile).not.toBeNull();

    crash();
    rust.failRestore = false;
    rust.pending.clear();
    await launch();
    await vi.waitFor(() => expect(tabs()).toHaveLength(3));
    expect(doc(tabFor(NOTES).id).content).toBe(NOTES_EDITED);
    expect(doc(tabFor(NOTES).id).isDirty).toBe(true);
  });

  it("a capture that fails aborts the restart: the app is not relaunched and nothing is lost", async () => {
    await launch();
    await workOnDocuments();
    statefulFs.stubCommand("hot_exit_capture", () => {
      throw new Error("capture timed out");
    });

    await expect(restartWithHotExit()).rejects.toThrow("capture timed out");

    expect(tauri.relaunch).not.toHaveBeenCalled();
    expect(doc(tabFor(NOTES).id).content).toBe(NOTES_EDITED);
    expect(doc(tabFor(NOTES).id).isDirty).toBe(true);
  });

  it("a session file that is not a session is left on disk and restores nothing", async () => {
    rust.sessionFile = JSON.stringify({ version: "not-a-number", windows: "nope" });

    await launch();
    await act(async () => {
      await settle(40);
    });

    expect(tabs()).toHaveLength(0);
    expect(rust.sessionFile).not.toBeNull();
  });
});

describe("Tier-0 crash recovery: a hard crash loses no unsaved document", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });

  async function tick(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("dirty documents are snapshotted, and come back as dirty tabs after the crash", async () => {
    await launch();
    const { scratchTitle } = await workOnDocuments();

    await tick(10_000);
    // One snapshot per DIRTY document; the clean one has nothing to recover.
    expect(recoveryFiles()).toHaveLength(2);

    crash(); // no capture: the session file does not exist
    expect(rust.sessionFile).toBeNull();
    await launch();
    await tick(0);

    expect(tabs()).toHaveLength(2);
    const notes = tabFor(NOTES);
    expect(doc(notes.id).content).toBe(NOTES_EDITED);
    expect(doc(notes.id).isDirty).toBe(true);
    const scratch = tabFor(null, scratchTitle);
    expect(doc(scratch.id).content).toBe(SCRATCH);
    expect(doc(scratch.id).isDirty).toBe(true);
    // A recovered snapshot is consumed: a second crash must not duplicate it.
    expect(recoveryFiles()).toHaveLength(0);
    // The file itself was never touched.
    expect(statefulFs.read(NOTES)).toBe(NOTES_ON_DISK);
  });

  it("the snapshot follows later edits, and saving removes it", async () => {
    await launch();
    const notesId = await openDocInTab(NOTES, NOTES_ON_DISK);
    editDoc(notesId, NOTES_EDITED);
    await tick(10_000);
    expect(recoveryFiles()).toHaveLength(1);

    editDoc(notesId, `${NOTES_EDITED}再改一次。\n`);
    await tick(10_000);
    expect(JSON.parse(statefulFs.read(recoveryFiles()[0])).content).toBe(`${NOTES_EDITED}再改一次。\n`);

    await act(async () => {
      await handleSave(WINDOW);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(doc(notesId).isDirty).toBe(false);
    expect(recoveryFiles()).toHaveLength(0);

    // Nothing left to recover: a crash now reopens no ghost tab.
    crash();
    await launch();
    await tick(0);
    expect(tabs()).toHaveLength(0);
  });

  it("a snapshot that is not valid JSON is skipped; the readable one is still recovered", async () => {
    await launch();
    const notesId = await openDocInTab(NOTES, NOTES_ON_DISK);
    editDoc(notesId, NOTES_EDITED);
    await tick(10_000);
    const [good] = recoveryFiles();
    statefulFs.seed(good.replace(notesId, "tab-corrupt"), "{ truncated");

    crash();
    await launch();
    await tick(0);

    expect(tabs()).toHaveLength(1);
    expect(doc(tabFor(NOTES).id).content).toBe(NOTES_EDITED);
  });
});
