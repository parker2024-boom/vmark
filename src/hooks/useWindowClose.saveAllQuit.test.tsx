// WI-RA25.2 — a window told by the quit coordinator to save everything (Save
// All and Quit) saves its own unsaved documents without asking, then closes;
// a save it cannot make — a cancelled Save As, a failed write — keeps it open
// and cancels the quit. Driven through the hook's real `app:quit-requested`
// listener over the real stores and save pipeline, with `@tauri-apps/*`
// behind the stateful fs fake, so every claim is about bytes on disk and what
// the window answered Rust.
import { render, act, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type QuitEvent = { payload: unknown };
const listeners = new Map<string, (event: QuitEvent) => void | Promise<void>>();

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: vi.fn((eventName: string, handler: (event: QuitEvent) => void) => {
      listeners.set(eventName, handler);
      return Promise.resolve(() => {});
    }),
  }),
}));
vi.mock("@tauri-apps/plugin-fs", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.fsModule();
});
vi.mock("@tauri-apps/api/core", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.coreModule();
});
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
  confirm: vi.fn(),
}));
// sonner is the external boundary; the IME-safe wrapper runs real.
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));
// The window label comes from the provider, which itself reaches Tauri.
vi.mock("@/contexts/WindowContext", () => ({ useWindowLabel: () => "main" }));

import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useWindowClose } from "./useWindowClose";
import { startTabStateCleanup } from "@/services/windowClose/tabCleanup";
import { bootstrapFormats } from "@/lib/formats/registryBootstrap";
import { statefulFs } from "@/test/statefulFsFake";
import {
  WINDOW,
  ROOT,
  resetTier0,
  openDocInTab,
  newUntitledTab,
  editDoc,
  doc,
  settle,
} from "@/test/tier0/harness";

const DOC = `${ROOT}/笔记.md`;
const OTHER = `${ROOT}/other.md`;
const ORIGINAL = "# 标题\n\n磁盘上的内容。\n";
const EDITED = "# 标题\n\n改过的内容。\n";

/** What the window answered Rust: how often it closed itself, and cancelled the quit. */
let closes = 0;
let cancels = 0;
let stopCleanup: () => void;

function Harness() {
  useWindowClose();
  return null;
}

/** Mount the window's close listeners and hand it the quit requests. The
 *  listener answers in the background, as the real event bus lets it. */
async function deliver(...payloads: unknown[]): Promise<void> {
  await act(async () => {
    render(<Harness />);
  });
  await waitFor(() => expect(listeners.has("app:quit-requested")).toBe(true));
  const listener = listeners.get("app:quit-requested")!;
  await act(async () => {
    await Promise.all(payloads.map((payload) => listener({ payload })));
  });
}

/** Hand the window a quit request and wait until it has answered Rust:
 *  closed itself, or cancelled the quit. */
async function requestQuit(...payloads: unknown[]): Promise<void> {
  await deliver(...payloads);
  await waitFor(() => expect(closes + cancels).toBeGreaterThan(0));
  await act(async () => {
    await settle();
  });
}

/** Hand the window a request it must not act on, and let it run out. */
async function requestIgnored(payload: unknown): Promise<void> {
  await deliver(payload);
  await act(async () => {
    await settle(50);
  });
}

const saveAll = { label: WINDOW, saveAll: true };

beforeEach(() => {
  listeners.clear();
  resetTier0();
  closes = 0;
  cancels = 0;
  statefulFs.stubCommand("close_window", () => {
    closes += 1;
  });
  statefulFs.stubCommand("cancel_quit", () => {
    cancels += 1;
  });
  statefulFs.stubCommand("window_close_log", () => undefined);
  // The exclusive-create the batch reserves untitled destinations with.
  statefulFs.stubCommand("create_file_exclusive", (args) => {
    const path = String(args.path);
    if (statefulFs.has(path)) return false;
    statefulFs.seed(path, "");
    return true;
  });
  vi.mocked(saveDialog).mockReset();
  vi.mocked(openDialog).mockReset();
  vi.mocked(message).mockReset();
  vi.mocked(ask).mockReset();
  vi.mocked(toast.error).mockClear();
  stopCleanup = startTabStateCleanup();
});

beforeAll(() => bootstrapFormats());

afterEach(() => {
  cleanup();
  stopCleanup();
});

describe("Save All and Quit — a window told to save everything", () => {
  it("writes every dirty document without asking, then closes", async () => {
    const edited = await openDocInTab(DOC, ORIGINAL);
    await openDocInTab(OTHER, "untouched\n");
    editDoc(edited, EDITED);

    await requestQuit(saveAll);

    expect(statefulFs.read(DOC)).toBe(EDITED);
    expect(statefulFs.writesTo(OTHER)).toEqual([]);
    expect(vi.mocked(message)).not.toHaveBeenCalled();
    expect(closes).toBe(1);
    expect(cancels).toBe(0);
  });

  it("closes at once when nothing needs saving", async () => {
    await openDocInTab(DOC, ORIGINAL);

    await requestQuit(saveAll);

    expect(statefulFs.writesTo(DOC)).toEqual([]);
    expect(closes).toBe(1);
    expect(cancels).toBe(0);
  });

  it("still asks where a never-saved document goes, and saves it there", async () => {
    const draft = newUntitledTab();
    editDoc(draft, "初稿\n");
    const target = `${ROOT}/初稿.md`;
    vi.mocked(saveDialog).mockResolvedValue(target);

    await requestQuit(saveAll);

    expect(vi.mocked(saveDialog)).toHaveBeenCalledTimes(1);
    expect(statefulFs.read(target)).toBe("初稿\n");
    expect(vi.mocked(message)).not.toHaveBeenCalled();
    expect(closes).toBe(1);
  });

  it("asks once for a folder when several documents were never saved", async () => {
    const first = newUntitledTab();
    const second = newUntitledTab();
    editDoc(first, "一\n");
    editDoc(second, "二\n");
    vi.mocked(openDialog).mockResolvedValue(ROOT);
    const before = new Set(statefulFs.paths());

    await requestQuit(saveAll);

    expect(vi.mocked(openDialog)).toHaveBeenCalledTimes(1);
    // The window has closed and taken its documents with it: read the disk.
    const created = statefulFs.paths().filter((p) => !before.has(p) && p.startsWith(`${ROOT}/`));
    expect(created.map((p) => statefulFs.read(p)).sort()).toEqual(["一\n", "二\n"]);
    expect(closes).toBe(1);
  });

  it("a cancelled Save As keeps the window open, the draft unsaved, and cancels the quit", async () => {
    const draft = newUntitledTab();
    editDoc(draft, "初稿\n");
    vi.mocked(saveDialog).mockResolvedValue(null);

    await requestQuit(saveAll);

    expect(closes).toBe(0);
    expect(cancels).toBe(1);
    expect(doc(draft).isDirty).toBe(true);
    expect(statefulFs.writes).toEqual([]);
  });

  it("a failed write keeps the window open with the error shown, and cancels the quit", async () => {
    const edited = await openDocInTab(DOC, ORIGINAL);
    editDoc(edited, EDITED);
    statefulFs.failWrites(new Error("disk full"));

    await requestQuit(saveAll);

    expect(closes).toBe(0);
    expect(cancels).toBe(1);
    expect(statefulFs.read(DOC)).toBe(ORIGINAL);
    expect(doc(edited).isDirty).toBe(true);
    expect(vi.mocked(toast.error)).toHaveBeenCalled();
  });

  it("a request repeated while the first is saving joins it: one write, one close", async () => {
    const edited = await openDocInTab(DOC, ORIGINAL);
    editDoc(edited, EDITED);

    await requestQuit(saveAll, saveAll);

    expect(statefulFs.writesTo(DOC)).toHaveLength(1);
    expect(closes).toBe(1);
    expect(cancels).toBe(0);
  });

  it("joins a close already asking about a document, and answers Rust once", async () => {
    // The traffic light started a close that is prompting; Save All and Quit
    // arrives meanwhile. The user's answer to the open prompt decides.
    const edited = await openDocInTab(DOC, ORIGINAL);
    editDoc(edited, EDITED);
    let answerPrompt!: (button: string) => void;
    vi.mocked(message).mockReturnValue(
      new Promise((resolve) => {
        answerPrompt = resolve;
      }),
    );
    await deliver();
    await act(async () => {
      await listeners.get("window:close-requested")!({ payload: WINDOW });
    });
    await waitFor(() => expect(vi.mocked(message)).toHaveBeenCalledTimes(1));

    const quit = listeners.get("app:quit-requested")!;
    await act(async () => {
      await quit({ payload: saveAll });
    });
    answerPrompt("Cancel");
    await waitFor(() => expect(cancels).toBe(1));
    await act(async () => {
      await settle();
    });

    expect(vi.mocked(message)).toHaveBeenCalledTimes(1);
    expect(statefulFs.writes).toEqual([]);
    expect(closes).toBe(0);
    expect(cancels).toBe(1);
  });

  it("ignores a request for another window", async () => {
    const edited = await openDocInTab(DOC, ORIGINAL);
    editDoc(edited, EDITED);

    await requestIgnored({ label: "doc-7", saveAll: true });

    expect(statefulFs.writes).toEqual([]);
    expect(closes).toBe(0);
    expect(cancels).toBe(0);
  });
});

describe("a quit that asks", () => {
  it("prompts for the unsaved document instead of saving it", async () => {
    const edited = await openDocInTab(DOC, ORIGINAL);
    editDoc(edited, EDITED);
    // The user cancels the save prompt.
    vi.mocked(message).mockResolvedValue("Cancel");

    await requestQuit({ label: WINDOW, saveAll: false });

    expect(vi.mocked(message)).toHaveBeenCalledTimes(1);
    expect(statefulFs.read(DOC)).toBe(ORIGINAL);
    expect(closes).toBe(0);
    expect(cancels).toBe(1);
  });

  it("ignores a malformed request rather than guessing which window it means", async () => {
    const edited = await openDocInTab(DOC, ORIGINAL);
    editDoc(edited, EDITED);

    await requestIgnored({ label: WINDOW });
    await requestIgnored(null);
    await requestIgnored(WINDOW);

    expect(statefulFs.writes).toEqual([]);
    expect(closes).toBe(0);
    expect(cancels).toBe(0);
  });
});
