// WI-RA17A.2 — universal toolbar navigation: two-step Escape, activation, focus tracking, dropdown exit
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useUIStore } from "@/stores/uiStore";
import { useEditorStore } from "@/stores/editorStore";
import { useGeniePickerStore } from "@/stores/geniePickerStore";
import { getGroupButtons } from "./toolbarGroups";
import type { ToolbarButtons } from "./useToolbarButtons";
import type { ToolbarMenu } from "./useToolbarMenu";
import { useToolbarNavigation } from "./useToolbarNavigation";

const buttons = getGroupButtons().slice(0, 2);

function makeModel(disabledIndex: number | null = null): ToolbarButtons {
  const buttonStates = buttons.map((_, i) => ({ disabled: i === disabledIndex, notImplemented: false, active: false }));
  return {
    buttons,
    toolbarContext: { surface: "wysiwyg", view: null, editor: null, context: null },
    buttonStates,
    genieFocusIndex: buttons.length,
    isButtonFocusable: (i) => i === buttons.length || !buttonStates[i]?.disabled,
    isDropdownButton: (i) => i < buttons.length,
  };
}

function makeMenu(menuOpen: boolean): ToolbarMenu {
  return {
    menuOpen,
    menuAnchor: null,
    openGroupId: null,
    openGroup: null,
    dropdownItems: [],
    menuRef: { current: null },
    openMenu: vi.fn(),
    switchMenu: vi.fn(),
    closeMenu: vi.fn(),
    resetMenu: vi.fn(),
  };
}

function Harness({ model, menu }: { model: ToolbarButtons; menu: ToolbarMenu }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nav = useToolbarNavigation(containerRef, true, model, menu);
  return (
    <>
      <div
        ref={containerRef}
        data-testid="toolbar"
        onKeyDown={nav.handleKeyDown}
        onFocusCapture={nav.handleFocusCapture}
        onBlurCapture={nav.handleBlurCapture}
      >
        {[0, 1, 2].map((i) => (
          <button key={i} type="button" className="universal-toolbar-btn" data-focus-index={i}>
            {`b${i}`}
          </button>
        ))}
      </div>
      <button type="button">outside</button>
      {(["forward", "right", "left"] as const).map((direction) => (
        <button key={direction} type="button" onClick={() => nav.handleDropdownExit(direction)}>
          {`exit-${direction}`}
        </button>
      ))}
    </>
  );
}

function setup(menuOpen = false, disabledIndex: number | null = null) {
  const model = makeModel(disabledIndex);
  const menu = makeMenu(menuOpen);
  render(<Harness model={model} menu={menu} />);
  return { menu, toolbar: screen.getByTestId("toolbar") };
}

const editorFocus = vi.fn();

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  editorFocus.mockClear();
  useEditorStore.setState((s) => ({ tiptap: { ...s.tiptap, editorView: { focus: editorFocus } as never } }));
  useUIStore.setState({
    universalToolbarVisible: true,
    universalToolbarHasFocus: false,
    toolbarSessionFocusIndex: 0,
  });
  useUIStore.getState().setSourceMode(false);
  useGeniePickerStore.getState().closePicker();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useToolbarNavigation — Escape", () => {
  it("closes an open dropdown first", () => {
    const { menu, toolbar } = setup(true);
    fireEvent.keyDown(toolbar, { key: "Escape" });
    expect(menu.closeMenu).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().universalToolbarVisible).toBe(true);
  });

  it("closes the toolbar and returns to the editor when no dropdown is open", () => {
    const { menu, toolbar } = setup(false);
    fireEvent.keyDown(toolbar, { key: "Escape" });
    expect(useUIStore.getState().universalToolbarVisible).toBe(false);
    expect(editorFocus).toHaveBeenCalledTimes(1);
    expect(menu.resetMenu).toHaveBeenCalledTimes(1);
  });
});

describe("useToolbarNavigation — activation", () => {
  it("opens the genie picker from the trailing AI-Prompts button", () => {
    const { toolbar } = setup();
    fireEvent.focus(screen.getByText("b2"));
    fireEvent.keyDown(toolbar, { key: "Enter" });
    expect(useGeniePickerStore.getState().isOpen).toBe(true);
    expect(useGeniePickerStore.getState().filterScope).toBe("selection");
  });

  it("opens a group's dropdown at its button", () => {
    const { menu, toolbar } = setup();
    fireEvent.keyDown(toolbar, { key: "Enter" });
    expect(menu.openMenu).toHaveBeenCalledWith(buttons[0].id, expect.objectContaining({ top: expect.any(Number) }));
  });

  it("opens a dropdown with ArrowDown", () => {
    const { menu, toolbar } = setup();
    fireEvent.keyDown(toolbar, { key: "ArrowDown" });
    expect(menu.openMenu).toHaveBeenCalledWith(buttons[0].id, expect.objectContaining({ top: expect.any(Number) }));
  });
});

describe("useToolbarNavigation — focus tracking", () => {
  it("records the focused button and marks the toolbar focused", () => {
    setup();
    fireEvent.focus(screen.getByText("b1"));
    expect(useUIStore.getState().toolbarSessionFocusIndex).toBe(1);
    expect(useUIStore.getState().universalToolbarHasFocus).toBe(true);
  });

  it("drops toolbar focus only when focus leaves the toolbar", () => {
    setup();
    useUIStore.setState({ universalToolbarHasFocus: true });
    fireEvent.blur(screen.getByText("b0"), { relatedTarget: screen.getByText("b1") });
    expect(useUIStore.getState().universalToolbarHasFocus).toBe(true);
    fireEvent.blur(screen.getByText("b0"), { relatedTarget: screen.getByText("outside") });
    expect(useUIStore.getState().universalToolbarHasFocus).toBe(false);
  });
});

describe("useToolbarNavigation — leaving a dropdown", () => {
  it("Tab closes the dropdown and focuses the next button", () => {
    const { menu } = setup(true);
    fireEvent.click(screen.getByText("exit-forward"));
    expect(menu.closeMenu).toHaveBeenCalledWith(false);
    expect(useUIStore.getState().toolbarSessionFocusIndex).toBe(1);
    expect(document.activeElement).toBe(screen.getByText("b1"));
  });

  it("an arrow onto an enabled dropdown switches to it", () => {
    const { menu } = setup(true);
    fireEvent.click(screen.getByText("exit-right"));
    expect(menu.switchMenu).toHaveBeenCalledWith(buttons[1].id, expect.objectContaining({ top: expect.any(Number) }));
    expect(menu.closeMenu).not.toHaveBeenCalled();
  });

  it("an arrow backwards wraps to the AI-Prompts button and closes the dropdown", () => {
    const { menu } = setup(true);
    fireEvent.click(screen.getByText("exit-left"));
    expect(useUIStore.getState().toolbarSessionFocusIndex).toBe(2);
    expect(menu.closeMenu).toHaveBeenCalledWith(false);
  });
});
