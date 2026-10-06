// WI-RA14D.1 — useStatusBarTabDrag: pointer reorder (allowed and pinned-zone
// blocked), keyboard reorder and activation, the reorder toast's undo, drag-out
// refusal, the cross-window drop-target probe with its stale-response guard,
// spring-loaded focus, and incoming drop-preview events.
//
// The pointer path runs through the real useTabDragOut against a tab bar with
// measured geometry; the boundaries are Tauri IPC (`invoke`, `emit`, `listen`),
// the toast surface and the warn logger.
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import i18n from "@/i18n";
import { imeToast } from "@/services/ime/imeToast";
import { useTabStore } from "@/stores/tabStore";
import { bootstrapFormats } from "@/lib/formats";
import { useStatusBarTabDrag } from "./useStatusBarTabDrag";

const logs = vi.hoisted(() => ({ statusBarWarn: vi.fn() }));
vi.mock("@/utils/debug", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/debug")>()),
  statusBarWarn: logs.statusBarWarn,
}));

const invokeMock = vi.mocked(invoke);
const emitMock = vi.mocked(emit);
const listenMock = vi.mocked(listen);

const TAB_WIDTH = 100;
const BAR_HEIGHT = 40;

type HookResult = ReturnType<typeof useStatusBarTabDrag>;
const latest: { current: HookResult | null } = { current: null };

/** The hook's result as of the last committed render. */
function hook(): HookResult {
  if (!latest.current) throw new Error("the harness has not rendered");
  return latest.current;
}
const onActivateTab = vi.fn();

function Harness({ windowLabel }: { windowLabel: string }) {
  const tabs = useTabStore((s) => s.tabs[windowLabel]) ?? [];
  const tabBarRef = useRef<HTMLDivElement>(null);
  const result = useStatusBarTabDrag({ tabs, windowLabel, tabBarRef, onActivateTab });
  useEffect(() => {
    latest.current = result;
  });
  return (
    <div ref={tabBarRef} data-testid="bar">
      <div role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-label={tab.title}
            onKeyDown={(e) => result.handleTabKeyDown(tab.id, e)}
          />
        ))}
      </div>
    </div>
  );
}

function withRect(el: Element, left: number, width: number): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: left, y: 0, top: 0, left, width, height: BAR_HEIGHT,
      right: left + width, bottom: BAR_HEIGHT, toJSON: () => ({}),
    }),
  });
}

/** Lay the bar out: tab i occupies [i*100, i*100+100), the bar is 40px tall. */
function layOut(): void {
  const bar = screen.getByTestId("bar");
  withRect(bar, 0, 1000);
  withRect(screen.getByRole("tablist"), 0, 1000);
  screen.queryAllByRole("tab").forEach((tab, i) => withRect(tab, i * TAB_WIDTH, TAB_WIDTH));
}

function mount(windowLabel: string) {
  const view = render(<Harness windowLabel={windowLabel} />);
  layOut();
  return view;
}

function pressTab(tabId: string, isPinned: boolean, clientX: number): void {
  const event = {
    button: 0, clientX, clientY: 20, pointerId: 1, pointerType: "mouse", target: null,
    currentTarget: {
      setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => false), releasePointerCapture: vi.fn(),
    },
  } as unknown as ReactPointerEvent;
  act(() => hook().getTabDragHandlers(tabId, isPinned).onPointerDown(event));
}

function pointer(type: "pointermove" | "pointerup", clientX: number, clientY: number): void {
  act(() => {
    document.dispatchEvent(new MouseEvent(type, {
      bubbles: true, clientX, clientY, screenX: clientX + 1000, screenY: clientY + 500,
    }));
  });
}

function tabIds(windowLabel: string): string[] {
  return (useTabStore.getState().tabs[windowLabel] ?? []).map((t) => t.id);
}

function openTabs(windowLabel: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    useTabStore.getState().createTab(windowLabel, `/notes/${windowLabel}-${i}.md`));
}

beforeAll(() => {
  // Tabs derive their format from the registry the app bootstraps at startup.
  bootstrapFormats({ dataFormats: false, diagrams: false, htmlPreview: false, codeViewers: false });
});

beforeEach(() => {
  latest.current = null;
  vi.useFakeTimers();
  for (const label of Object.keys(useTabStore.getState().tabs)) useTabStore.getState().removeWindow(label);
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  emitMock.mockClear();
  listenMock.mockClear();
  logs.statusBarWarn.mockClear();
  onActivateTab.mockClear();
  document.body.style.cursor = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pointer reorder", () => {
  it("moves the tab, toasts with an undo that restores the order, and announces it", () => {
    const [a, b, c] = openTabs("doc-1", 3);
    const message = vi.spyOn(imeToast, "message");
    mount("doc-1");

    pressTab(a, false, 50);
    pointer("pointermove", 250, 20);
    expect(hook().dragMode).toBe("reorder");
    expect(hook().dragHint).toBe(i18n.t("statusbar:tabDrag.reorder"));
    expect(document.body.style.cursor).toBe("grabbing");
    pointer("pointerup", 250, 20);

    expect(tabIds("doc-1")).toEqual([b, c, a]);
    expect(document.body.style.cursor).toBe("");
    const title = useTabStore.getState().findTabById(a)!.title;
    expect(hook().ariaAnnouncement).toBe(i18n.t("dialog:toast.tabReorderedAnnounce", { title }));
    expect(message).toHaveBeenCalledWith(
      i18n.t("dialog:toast.tabReordered", { title }), expect.anything());

    const action = message.mock.calls[0][1]?.action;
    if (!action || typeof action !== "object" || !("onClick" in action)) {
      throw new Error("the reorder toast carries no undo action");
    }
    // The handler ignores its click event, so it is invoked without one.
    const undo: (...args: never[]) => void = action.onClick;
    act(() => undo());
    expect(tabIds("doc-1")).toEqual([a, b, c]);

    act(() => vi.advanceTimersByTime(1200));
    expect(hook().ariaAnnouncement).toBe("");
  });

  it("blocks a drop into the pinned zone: not-allowed cursor, snapback, announcement, order kept", () => {
    const [a, b, c] = openTabs("doc-1", 3);
    useTabStore.getState().togglePin("doc-1", a);
    useTabStore.getState().togglePin("doc-1", b);
    const before = tabIds("doc-1");
    const message = vi.spyOn(imeToast, "message");
    mount("doc-1");

    pressTab(c, false, 250);
    pointer("pointermove", 10, 20);
    expect(hook().isReorderBlocked).toBe(true);
    expect(hook().isDropInvalid).toBe(true);
    expect(hook().dragHint).toBe(i18n.t("statusbar:tabDrag.pinnedZone"));
    expect(document.body.style.cursor).toBe("not-allowed");
    pointer("pointerup", 10, 20);

    expect(tabIds("doc-1")).toEqual(before);
    expect(message).not.toHaveBeenCalled();
    expect(hook().snapbackTabId).toBe(c);
    expect(hook().ariaAnnouncement).toBe(i18n.t("dialog:toast.tabDropPinnedZone"));

    act(() => vi.advanceTimersByTime(180));
    expect(hook().snapbackTabId).toBeNull();
  });
});

describe("keyboard", () => {
  // userEvent schedules its own steps on the real clock and stalls under fake
  // timers; nothing asserted here depends on a timer firing.
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("Alt+Shift+ArrowRight reorders the focused tab one step to the right", async () => {
    const [a, b, c] = openTabs("doc-1", 3);
    mount("doc-1");
    const user = userEvent.setup();

    screen.getAllByRole("tab")[0].focus();
    await user.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
    expect(tabIds("doc-1")).toEqual([b, a, c]);
  });

  it("Enter activates the focused tab", async () => {
    const [, b] = openTabs("doc-1", 2);
    mount("doc-1");
    const user = userEvent.setup();

    screen.getAllByRole("tab")[1].focus();
    await user.keyboard("{Enter}");
    expect(onActivateTab).toHaveBeenCalledWith(b);
  });
});

describe("drag-out", () => {
  it("refuses to move the last tab out of the main window", async () => {
    const [only] = openTabs("main", 1);
    mount("main");

    pressTab(only, false, 50);
    pointer("pointermove", 50, 200);
    expect(hook().dragMode).toBe("dragout");
    expect(hook().isDropInvalid).toBe(true);
    expect(hook().dragHint).toBe(i18n.t("statusbar:tabDrag.lastTab"));
    pointer("pointerup", 50, 200);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(tabIds("main")).toEqual([only]);
    expect(hook().snapbackTabId).toBe(only);
    expect(hook().ariaAnnouncement).toBe(i18n.t("dialog:toast.cannotMoveLastTab"));
    expect(emitMock).toHaveBeenCalledWith("tab:drop-preview", {
      sourceWindowLabel: "main", targetWindowLabel: null,
    });
  });

  it("probes for a target window, broadcasts it, and spring-focuses it once", async () => {
    const [a] = openTabs("doc-1", 2);
    invokeMock.mockImplementation((cmd) =>
      Promise.resolve(cmd === "find_drop_target_window" ? "doc-2" : undefined));
    mount("doc-1");

    pressTab(a, false, 50);
    pointer("pointermove", 50, 200);
    expect(hook().dragHint).toBe(i18n.t("statusbar:tabDrag.newWindow"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });

    expect(invokeMock).toHaveBeenCalledWith("find_drop_target_window", { screenX: 1050, screenY: 700 });
    expect(hook().dragHint).toBe(i18n.t("statusbar:tabDrag.moveToWindow", { window: "doc-2" }));
    expect(emitMock).toHaveBeenCalledWith("tab:drop-preview", {
      sourceWindowLabel: "doc-1", targetWindowLabel: "doc-2",
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(420); });
    expect(invokeMock).toHaveBeenCalledWith("focus_existing_window", { windowLabel: "doc-2" });

    // Hovering on over the same window does not focus it again.
    pointer("pointermove", 60, 210);
    await act(async () => { await vi.advanceTimersByTimeAsync(60 + 420); });
    const focusCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "focus_existing_window");
    expect(focusCalls).toHaveLength(1);
  });

  it("discards a probe answer that arrives after the drag ended", async () => {
    // No document behind the tab: the release snaps back without any IPC, so
    // the only find_drop_target_window call is the probe held open here.
    const [a] = openTabs("doc-1", 2);
    let answer!: (label: string) => void;
    invokeMock.mockImplementation((cmd) =>
      cmd === "find_drop_target_window"
        ? new Promise((resolve) => { answer = resolve as (label: string) => void; })
        : Promise.resolve(undefined));
    mount("doc-1");

    pressTab(a, false, 50);
    pointer("pointermove", 50, 200);
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    pointer("pointerup", 50, 200);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hook().ariaAnnouncement).toBe(i18n.t("dialog:toast.cannotMoveTabNoDoc"));
    emitMock.mockClear();

    await act(async () => { answer("doc-2"); await vi.advanceTimersByTimeAsync(500); });
    expect(hook().dragHint).toBe(i18n.t("statusbar:tabDrag.reorder"));
    expect(emitMock).not.toHaveBeenCalledWith("tab:drop-preview", expect.objectContaining({
      targetWindowLabel: "doc-2",
    }));
    expect(invokeMock).not.toHaveBeenCalledWith("focus_existing_window", expect.anything());
  });

  it("logs a failed probe and a failed spring focus instead of throwing", async () => {
    const [a] = openTabs("doc-1", 2);
    invokeMock.mockImplementation((cmd) =>
      cmd === "find_drop_target_window"
        ? Promise.resolve("doc-2")
        : Promise.reject(new Error("window gone")));
    mount("doc-1");

    pressTab(a, false, 50);
    pointer("pointermove", 50, 200);
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    await act(async () => { await vi.advanceTimersByTimeAsync(420); });
    expect(logs.statusBarWarn).toHaveBeenCalledWith(
      "Failed to focus spring-loaded target:", "window gone");

    invokeMock.mockImplementation(() => Promise.reject(new Error("probe failed")));
    pointer("pointermove", 70, 220);
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(logs.statusBarWarn).toHaveBeenCalledWith("Failed to probe drop target:", "probe failed");
  });
});

describe("incoming drop-preview events", () => {
  type PreviewHandler = (event: { payload: { sourceWindowLabel: string; targetWindowLabel: string | null } }) => void;

  it("highlights this window only when another window targets it, and unlistens on unmount", async () => {
    const unlisten = vi.fn();
    let handler!: PreviewHandler;
    listenMock.mockImplementationOnce((_event, cb) => {
      handler = cb as unknown as PreviewHandler;
      return Promise.resolve(unlisten);
    });
    openTabs("doc-1", 1);
    const view = mount("doc-1");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listenMock).toHaveBeenCalledWith("tab:drop-preview", expect.any(Function));

    act(() => handler({ payload: { sourceWindowLabel: "doc-2", targetWindowLabel: "doc-1" } }));
    expect(hook().isDropPreviewTarget).toBe(true);
    // This window's own broadcast never highlights itself.
    act(() => handler({ payload: { sourceWindowLabel: "doc-1", targetWindowLabel: "doc-3" } }));
    expect(hook().isDropPreviewTarget).toBe(true);
    act(() => handler({ payload: { sourceWindowLabel: "doc-2", targetWindowLabel: "doc-3" } }));
    expect(hook().isDropPreviewTarget).toBe(false);

    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens immediately when unmounted before the listener registered", async () => {
    const unlisten = vi.fn();
    let register!: (fn: () => void) => void;
    listenMock.mockImplementationOnce(() => new Promise((resolve) => { register = resolve; }));
    openTabs("doc-1", 1);
    const view = mount("doc-1");

    view.unmount();
    await act(async () => { register(unlisten); await vi.advanceTimersByTimeAsync(0); });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("logs a listener registration failure", async () => {
    listenMock.mockImplementationOnce(() => Promise.reject(new Error("no event bus")));
    openTabs("doc-1", 1);
    mount("doc-1");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(logs.statusBarWarn).toHaveBeenCalledWith(
      "Failed to listen for drop preview events:", "no event bus");
  });
});
