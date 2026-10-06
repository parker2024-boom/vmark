// WI-RA14C.5 — the update flow as the main window runs it: a check → the state
// the UI renders → download progress → install → restart, plus the automatic
// check's schedule, its backoff, the single-flight guard and the skip rule.
//
// REAL: `runUpdateCheck` / `runUpdateDownload` with their single-flight guards
// and progress throttle, the update slice of `mcpStore`, the settings store,
// the three update hooks MainWindowRunners mounts (`useUpdateChecker`,
// `useUpdateBroadcast`, `useUpdateListener`), `useUpdateToasts` (the status
// bar's surface), `useUpdateOperations` (the buttons) and `restartWithHotExit`.
// FAKED: `@tauri-apps/plugin-updater` (`check` answers one network round trip
// later on the fake clock; the Update handle's download is scripted), `api/app`,
// `plugin-process` (`relaunch`), `api/core` (an unlisted command rejects),
// `api/event` (an in-memory bus: `emit` reaches every `listen`er a microtask
// later, the emitting window included, as Tauri's global emit does) and sonner.
// NOT HERE: refusing an equal or older version is the updater plugin's own
// comparison, in Rust — the frontend offers whatever `check()` returns. The real
// HTTP check is the journey's (e2e/journeys/47-update-checker.mjs).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

type DownloadEvent = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };
type Toast = { kind: string; message: string; id?: string; duration?: number; action?: { label?: string; onClick?: () => void } };
type Listener = (event: { payload: unknown }) => void;

const tauri = vi.hoisted(() => ({
  check: vi.fn<(options?: { timeout?: number }) => Promise<unknown>>(),
  capture: vi.fn<() => Promise<unknown>>(),
  /** Commands invoked and events emitted, in order (`update_log` excluded). */
  trace: [] as string[],
  listeners: new Map<string, Set<Listener>>(),
  toasts: [] as Toast[],
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: tauri.check }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("1.0.0") }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => Promise.resolve(void tauri.trace.push("relaunch")) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    if (command === "update_log") return Promise.resolve();
    tauri.trace.push(command);
    return command === "hot_exit_capture" ? tauri.capture() : Promise.reject(new Error(`unstubbed Tauri command: ${command}`));
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, listener: Listener) => {
    const registered = tauri.listeners.get(event) ?? new Set<Listener>();
    tauri.listeners.set(event, registered.add(listener));
    return Promise.resolve(() => void registered.delete(listener));
  },
  emit: (event: string, payload?: unknown) => {
    tauri.trace.push(event);
    return Promise.resolve().then(() => [...(tauri.listeners.get(event) ?? [])].forEach((listener) => listener({ payload })));
  },
}));
vi.mock("sonner", () => {
  const show = (kind: string) => (message: string, options?: Omit<Toast, "kind" | "message">) => void tauri.toasts.push({ kind, message, ...options });
  return { toast: { info: show("info"), success: show("success"), error: show("error"), warning: show("warning"), dismiss: () => undefined } };
});

import { emit } from "@tauri-apps/api/event";
import { useMcpStore } from "@/stores/mcpStore";
import { useSettingsStore, type UpdateSettings } from "@/stores/settingsStore";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useUpdateChecker } from "@/hooks/useUpdateChecker";
import { useUpdateBroadcast, useUpdateListener, __resetUpdateSyncStateForTests } from "@/hooks/useUpdateSync";
import { useUpdateToasts } from "@/hooks/useStatusToasts";
import { useUpdateOperations } from "@/hooks/useUpdateOperations";
import { clearInFlight } from "@/services/updates/updateSingleFlight";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 2, 1);
/** One network round trip: the update server never answers in the task that asked. */
const NET = 50;

const update = () => useMcpStore.getState().update;
const lastCheck = () => useSettingsStore.getState().update.lastCheckTimestamp;
const restartSteps = () => tauri.trace.filter((step) => ["hot_exit_capture", "relaunch", "update:restart-cancelled"].includes(step));
/** Advance the fake clock, letting promise chains and React effects settle. */
const tick = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
/** Do something, then wait out one server round trip. */
const andAnswer = (action: () => unknown) => act(async () => void (action(), await vi.advanceTimersByTimeAsync(NET)));
/** An event another window (or Rust) emits to this one. */
const fromAnotherWindow = (event: string) => andAnswer(() => emit(event));

/** What the server answers to each check, in order (the last answer repeats). */
function serverAnswers(...answers: unknown[]) {
  tauri.check.mockImplementation(() => new Promise((resolve, reject) => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    setTimeout(() => (answer instanceof Error || typeof answer === "string" ? reject(answer) : resolve(answer)), NET);
  }));
}

/** A release on the fake update server, with a download the test scripts. */
function release(version: string, body?: string, date?: string) {
  let report: (event: DownloadEvent) => void = () => {};
  let settle = { resolve: () => {}, reject: (_reason: unknown) => {} };
  const downloadAndInstall = vi.fn((onEvent: (event: DownloadEvent) => void) => {
    report = onEvent;
    return new Promise<void>((resolve, reject) => void (settle = { resolve, reject }));
  });
  const send = (event: DownloadEvent) => act(async () => report(event));
  return { handle: { version, body, date, downloadAndInstall }, send, finish: () => act(async () => settle.resolve()), fail: (reason: unknown) => act(async () => settle.reject(reason)) };
}

/** Everything the main window mounts for updates, plus the adapters its buttons call. */
function mountMainWindow(settings: Partial<UpdateSettings> = { checkFrequency: "manual" }) {
  useSettingsStore.setState((s) => ({ update: { ...s.update, ...settings } }));
  return renderHook(() => {
    useUpdateChecker();
    useUpdateBroadcast();
    useUpdateListener();
    useUpdateToasts();
    return useUpdateOperations();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  localStorage.clear();
  tauri.check.mockReset();
  tauri.capture.mockReset().mockResolvedValue({ windows: [], vmark_version: "1.0.0" });
  tauri.trace.length = tauri.toasts.length = 0;
  tauri.listeners.clear();
  clearInFlight();
  __resetUpdateSyncStateForTests();
  useMcpStore.getState().resetUpdate();
  useSettingsStore.getState().resetSettings();
  useTabStore.setState({ tabs: {}, activeTabId: {} });
  useDocumentStore.setState({ documents: {} });
});

describe("Tier-0 update check — a check and what the UI renders", () => {
  it("no update: settles on up-to-date, stamps the check time, and answers a user who asked", async () => {
    serverAnswers(null);
    mountMainWindow();
    await fromAnotherWindow("update:request-check");
    expect(update()).toEqual({ status: "up-to-date", updateInfo: null, downloadProgress: null, error: null, dismissed: false, pendingUpdate: null });
    expect(lastCheck()).toBe(NOW + NET);
    expect(tauri.check.mock.calls).toEqual([[{ timeout: 30_000 }]]);
    expect(tauri.toasts).toContainEqual({ kind: "success", message: "You're up to date!", duration: 3000 });
  });

  it.each([
    ["with notes and a date", "## 更新\n- 修复 CJK 断行\r\n- émoji 🎉", "2026-02-27T10:00:00Z"],
    ["with neither", undefined, undefined],
  ])("update found %s: version, notes, date and the running version reach the state the UI renders", async (_label, notes, date) => {
    const v2 = release("2.0.0", notes, date);
    serverAnswers(v2.handle);
    const { result } = mountMainWindow();
    await andAnswer(() => result.current.checkForUpdates());
    const updateInfo = { version: "2.0.0", notes: notes ?? "", pubDate: date ?? "", currentVersion: "1.0.0" };
    expect(update()).toEqual({ status: "available", updateInfo, downloadProgress: null, error: null, dismissed: false, pendingUpdate: v2.handle });
    expect(lastCheck()).toBe(NOW + NET);
    expect(tauri.toasts.at(-1)).toMatchObject({ kind: "info", id: "status-update", message: "Update available: v2.0.0", action: { label: "View" } });
  });

  it("a failed check reports the error without stamping the check time; a retry recovers; nothing is downloaded", async () => {
    serverAnswers("offline", new Error("dns error: 无法解析"), null);
    const { result } = mountMainWindow();
    await andAnswer(() => result.current.checkForUpdates());
    expect(update()).toMatchObject({ status: "error", error: "Failed to check for updates" });
    await andAnswer(() => result.current.checkForUpdates());
    expect(update()).toMatchObject({ status: "error", error: "dns error: 无法解析", pendingUpdate: null });
    expect(lastCheck()).toBeNull();

    // Download with nothing found: the button's path re-checks and stops there.
    await andAnswer(() => result.current.downloadAndInstall());
    expect(update()).toMatchObject({ status: "up-to-date", error: null, downloadProgress: null });
    expect(lastCheck()).toBe(NOW + 3 * NET);
    // ...and a peer window's download request has nothing to act on, and says so.
    await fromAnotherWindow("update:request-download");
    expect(update()).toMatchObject({ status: "error", error: "No update available to download", downloadProgress: null });
  });

  it("a check already in flight is joined, not doubled, and the guard releases once it settles", async () => {
    serverAnswers(null);
    const { result } = mountMainWindow();
    // Two clicks and a peer window's request, all before the server answers.
    await act(async () => void (result.current.checkForUpdates(), result.current.checkForUpdates(), await emit("update:request-check")));
    expect(update().status).toBe("checking");
    expect(tauri.check).toHaveBeenCalledTimes(1);

    await tick(NET);
    expect(update().status).toBe("up-to-date");
    await andAnswer(() => result.current.checkForUpdates());
    expect(tauri.check).toHaveBeenCalledTimes(2);
  });
});

describe("Tier-0 update check — download, install, restart", () => {
  /** A main window that has just found v2.0.0. */
  async function withUpdateFound() {
    const v2 = release("2.0.0");
    serverAnswers(v2.handle);
    const { result } = mountMainWindow();
    await andAnswer(() => result.current.checkForUpdates());
    return { v2, result };
  }

  it("progress advances by whole percents, install follows, and only then is a restart offered and reached", async () => {
    const { v2, result } = await withUpdateFound();
    await act(async () => void (result.current.downloadAndInstall(), result.current.downloadAndInstall()));
    expect(update()).toMatchObject({ status: "downloading", downloadProgress: { downloaded: 0, total: null } });
    await v2.send({ event: "Started", data: { contentLength: 1000 } });
    await v2.send({ event: "Progress", data: { chunkLength: 250 } });
    expect(update().downloadProgress).toEqual({ downloaded: 250, total: 1000 });
    await v2.send({ event: "Progress", data: { chunkLength: 4 } });
    expect(update().downloadProgress).toEqual({ downloaded: 250, total: 1000 }); // same percent: not written
    await v2.send({ event: "Progress", data: { chunkLength: 246 } });
    expect(update().downloadProgress).toEqual({ downloaded: 500, total: 1000 });
    await v2.send({ event: "Finished" });
    expect(update()).toMatchObject({ status: "installing", downloadProgress: { downloaded: 1000, total: 1000 } });
    // The bytes are in but the installer has not returned: no restart on offer, none taken.
    expect(tauri.toasts.filter((toast) => toast.action?.label === "Restart")).toEqual([]);
    expect(restartSteps()).toEqual([]);

    await v2.finish();
    expect(update()).toMatchObject({ status: "ready", downloadProgress: null, error: null });
    expect(v2.handle.downloadAndInstall).toHaveBeenCalledTimes(1);
    const ready = tauri.toasts.at(-1);
    expect(ready).toMatchObject({ kind: "success", id: "status-update", message: "v2.0.0 ready to install", duration: Infinity, action: { label: "Restart" } });
    await andAnswer(() => ready?.action?.onClick?.());
    expect(restartSteps()).toEqual(["hot_exit_capture", "relaunch"]);
  });

  it("a failed download clears progress, reports the error, and its Retry checks again", async () => {
    const { v2, result } = await withUpdateFound();
    await act(async () => void result.current.downloadAndInstall());
    await v2.send({ event: "Started", data: {} });
    await v2.fail(new Error("connection reset"));
    expect(update()).toMatchObject({ status: "error", error: "connection reset", downloadProgress: null });
    const failed = tauri.toasts.at(-1);
    expect(failed).toMatchObject({ kind: "error", id: "status-update", message: "Update check failed", duration: Infinity, action: { label: "Retry" } });
    await andAnswer(() => failed?.action?.onClick?.());
    expect(tauri.check).toHaveBeenCalledTimes(2);
    expect(update()).toMatchObject({ status: "available", error: null });
  });

  it("refuses to restart when the session capture fails, or unsaved work is not confirmed", async () => {
    const { result } = mountMainWindow();
    tauri.capture.mockRejectedValueOnce({ code: "IO_ERROR", message: "disk full" });
    await andAnswer(() => result.current.restartApp());
    expect(restartSteps()).toEqual(["hot_exit_capture", "update:restart-cancelled"]);

    tauri.trace.length = 0;
    const tabId = useTabStore.getState().createTab("main", null);
    useDocumentStore.getState().initDocument(tabId, "", null);
    useDocumentStore.getState().setEditorContent(tabId, "未保存的内容");
    await andAnswer(() => result.current.restartApp());
    expect(restartSteps()).toEqual(["update:restart-cancelled"]);
  });

  it("a skipped version is never downloaded again, while a newer one is", async () => {
    const { v2, result } = await withUpdateFound();
    const v21 = release("2.1.0");
    serverAnswers(v2.handle, v21.handle);
    act(() => result.current.skipVersion("2.0.0"));
    expect(update()).toMatchObject({ status: "idle", updateInfo: null, pendingUpdate: null });
    expect(localStorage.getItem("vmark-settings")).toContain('"skipVersion":"2.0.0"');
    act(() => useSettingsStore.getState().updateUpdateSetting("autoDownload", true));
    await andAnswer(() => result.current.checkForUpdates());
    expect(update()).toMatchObject({ status: "available", dismissed: true, pendingUpdate: null });
    expect(v2.handle.downloadAndInstall).not.toHaveBeenCalled();
    await andAnswer(() => result.current.checkForUpdates());
    expect(update()).toMatchObject({ status: "downloading", dismissed: false, pendingUpdate: v21.handle });
    expect(v21.handle.downloadAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe("Tier-0 update check — the automatic check", () => {
  it.each([
    ["auto-check off", { autoCheckEnabled: false }, 0],
    ["manual frequency", { checkFrequency: "manual" }, 0],
    ["at startup, even a minute after the last check", { lastCheckTimestamp: NOW - 60_000 }, 1],
    ["daily, never checked", { checkFrequency: "daily" }, 1],
    ["daily, checked 23 h ago", { checkFrequency: "daily", lastCheckTimestamp: NOW - 23 * HOUR }, 0],
    ["daily, checked 24 h ago", { checkFrequency: "daily", lastCheckTimestamp: NOW - 24 * HOUR }, 1],
    ["weekly, checked 6 d ago", { checkFrequency: "weekly", lastCheckTimestamp: NOW - 6 * 24 * HOUR }, 0],
    ["weekly, checked 7 d ago", { checkFrequency: "weekly", lastCheckTimestamp: NOW - 7 * 24 * HOUR }, 1],
  ] as const)("%s → %j runs %i check(s) after launch", async (_label, settings, checks) => {
    serverAnswers(null);
    mountMainWindow(settings);
    await tick(10_000);
    expect(tauri.check).toHaveBeenCalledTimes(checks);
    expect(lastCheck()).toBe(checks ? NOW + 2000 + NET : ("lastCheckTimestamp" in settings ? settings.lastCheckTimestamp : null));
  });

  it("waits 2 s after launch, retries a failing server after 5 s, 10 s and 20 s, then gives up with one notice", async () => {
    serverAnswers(new Error("offline"));
    const checksAfter = async (ms: number) => (await tick(ms), tauri.check.mock.calls.length);
    const { unmount } = mountMainWindow({});
    expect([await checksAfter(1999), await checksAfter(1)]).toEqual([0, 1]);
    expect([await checksAfter(NET + 4999), await checksAfter(1)]).toEqual([1, 2]);
    expect([await checksAfter(NET + 9999), await checksAfter(1)]).toEqual([2, 3]);
    expect([await checksAfter(NET + 19_999), await checksAfter(1)]).toEqual([3, 4]);
    expect(await checksAfter(10 * HOUR)).toBe(4);
    // Background failures stay quiet; only the exhaustion is announced, once.
    expect(tauri.toasts.filter((toast) => toast.kind === "error")).toMatchObject([
      { id: "update-retries-exhausted", message: "Couldn't reach update server after several attempts. Try again later.", duration: 6000 },
    ]);
    expect(update()).toMatchObject({ status: "error", error: "offline" });

    // A window that goes away during its startup delay never checks at all.
    unmount();
    mountMainWindow({}).unmount();
    expect(await checksAfter(10_000)).toBe(4);
  });
});
