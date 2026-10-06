// WI-RA17A.2 — the universal toolbar dropdown: open/close, store sync, focus-leave and outside clicks
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUIStore } from "@/stores/uiStore";
import type { ToolbarContext } from "@/plugins/toolbarActions/types";
import { TOOLBAR_GROUPS } from "./toolbarGroups";
import { toolbarButtonAt, useToolbarMenu } from "./useToolbarMenu";

const context: ToolbarContext = { surface: "wysiwyg", view: null, editor: null, context: null };

let container: HTMLDivElement;
let button: HTMLButtonElement;
const rect = new DOMRect(1, 2, 3, 4);
const group = TOOLBAR_GROUPS[0];

function setup(hasFocus = true) {
  const containerRef = { current: container };
  return renderHook(({ focus }) => useToolbarMenu(containerRef, focus, context), {
    initialProps: { focus: hasFocus },
  });
}

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  container = document.createElement("div");
  button = document.createElement("button");
  button.className = "universal-toolbar-btn";
  button.dataset.focusIndex = "0";
  container.append(button);
  document.body.append(container);
  useUIStore.setState({
    universalToolbarVisible: true,
    universalToolbarHasFocus: true,
    toolbarSessionFocusIndex: 0,
    toolbarDropdownOpen: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  container.remove();
});

describe("toolbarButtonAt", () => {
  it("finds the button by roving index, or nothing", () => {
    expect(toolbarButtonAt({ current: container }, 0)).toBe(button);
    expect(toolbarButtonAt({ current: container }, 5)).toBeNull();
    expect(toolbarButtonAt({ current: null }, 0)).toBeUndefined();
  });
});

describe("useToolbarMenu", () => {
  it("opens a group's dropdown at the anchor and raises the store flag", () => {
    const { result } = setup();
    act(() => result.current.openMenu(group.id, rect));
    expect(result.current.menuOpen).toBe(true);
    expect(result.current.menuAnchor).toBe(rect);
    expect(result.current.openGroup?.id).toBe(group.id);
    expect(result.current.dropdownItems).toHaveLength(group.items.length);
    expect(useUIStore.getState().toolbarDropdownOpen).toBe(true);
  });

  it("closes, lowers the store flag and returns focus to the session's button", () => {
    const { result } = setup();
    act(() => result.current.openMenu(group.id, rect));
    act(() => result.current.closeMenu());
    expect(result.current.menuOpen).toBe(false);
    expect(result.current.openGroup).toBeNull();
    expect(result.current.dropdownItems).toEqual([]);
    expect(useUIStore.getState().toolbarDropdownOpen).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it("does not move focus when asked not to, or when the toolbar is hidden", () => {
    const { result } = setup();
    act(() => result.current.closeMenu(false));
    expect(document.activeElement).not.toBe(button);
    useUIStore.setState({ universalToolbarVisible: false });
    act(() => result.current.closeMenu());
    expect(document.activeElement).not.toBe(button);
  });

  it("does not move focus when no button is in the session", () => {
    useUIStore.setState({ toolbarSessionFocusIndex: -1 });
    const { result } = setup();
    act(() => result.current.closeMenu());
    expect(document.activeElement).not.toBe(button);
  });

  it("switches groups without closing, and resetMenu leaves the store alone", () => {
    const { result } = setup();
    act(() => result.current.openMenu(group.id, rect));
    const other = TOOLBAR_GROUPS[1];
    const otherRect = new DOMRect(9, 9, 9, 9);
    act(() => result.current.switchMenu(other.id, otherRect));
    expect(result.current.menuOpen).toBe(true);
    expect(result.current.openGroupId).toBe(other.id);
    expect(result.current.menuAnchor).toBe(otherRect);

    act(() => result.current.resetMenu());
    expect(result.current.menuOpen).toBe(false);
    expect(useUIStore.getState().toolbarDropdownOpen).toBe(true);
  });

  it("closes when the store flag drops (global Escape)", () => {
    const { result } = setup();
    act(() => result.current.openMenu(group.id, rect));
    act(() => useUIStore.getState().setToolbarDropdownOpen(false));
    expect(result.current.menuOpen).toBe(false);
  });

  it("closes when focus leaves the toolbar", () => {
    const { result, rerender } = setup();
    act(() => result.current.openMenu(group.id, rect));
    rerender({ focus: false });
    expect(result.current.menuOpen).toBe(false);
  });

  it("closes on a click outside, but not inside the dropdown or on the toolbar", () => {
    const { result } = setup();
    const menuEl = document.createElement("div");
    document.body.append(menuEl);
    result.current.menuRef.current = menuEl;
    act(() => result.current.openMenu(group.id, rect));

    act(() => { menuEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    act(() => { button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(result.current.menuOpen).toBe(true);

    act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(result.current.menuOpen).toBe(false);
    menuEl.remove();
  });
});
