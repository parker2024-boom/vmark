// WI-RA17A.2 — the universal toolbar's open/close session: initial focus, session memory, focus hand-back
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useUIStore } from "@/stores/uiStore";
import { useEditorStore } from "@/stores/editorStore";
import { imeToast } from "@/services/ime/imeToast";
import { focusActiveEditor, useToolbarSession } from "./useToolbarSession";
import type { ToolbarButtons } from "./useToolbarButtons";

type States = ToolbarButtons["buttonStates"];

const enabled = (n: number): States =>
  Array.from({ length: n }, () => ({ disabled: false, notImplemented: false, active: false }));
const disabled = (n: number): States =>
  Array.from({ length: n }, () => ({ disabled: true, notImplemented: false, active: false }));

let container: HTMLDivElement;
let inner: HTMLButtonElement;

interface Props {
  visible: boolean;
  hasFocus: boolean;
  states: States;
  focusedIndex: number;
}

function setup(initial: Partial<Props> = {}) {
  const setFocusedIndex = vi.fn();
  const closeMenu = vi.fn();
  const containerRef = { current: container };
  const initialProps: Props = { visible: true, hasFocus: true, states: enabled(3), focusedIndex: -1, ...initial };
  const hook = renderHook(
    ({ visible, hasFocus, states, focusedIndex }: Props) =>
      useToolbarSession({
        visible,
        toolbarHasFocus: hasFocus,
        containerRef,
        buttonStates: states,
        focusedIndex,
        setFocusedIndex,
        closeMenu,
      }),
    { initialProps },
  );
  return { ...hook, setFocusedIndex, closeMenu, initialProps };
}

const wysiwygFocus = vi.fn();
const sourceFocus = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  inner = document.createElement("button");
  container.append(inner);
  document.body.append(container);
  wysiwygFocus.mockClear();
  sourceFocus.mockClear();
  useEditorStore.setState((s) => ({
    tiptap: { ...s.tiptap, editorView: { focus: wysiwygFocus } as never },
    source: { ...s.source, editorView: { focus: sourceFocus } as never },
  }));
  useUIStore.setState({ universalToolbarVisible: true, toolbarSessionFocusIndex: -1 });
  useUIStore.getState().setSourceMode(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  container.remove();
});

describe("focusActiveEditor", () => {
  it("focuses the WYSIWYG view, or the Source view in source mode", () => {
    focusActiveEditor();
    expect(wysiwygFocus).toHaveBeenCalledTimes(1);
    useUIStore.getState().setSourceMode(true);
    focusActiveEditor();
    expect(sourceFocus).toHaveBeenCalledTimes(1);
  });
});

describe("useToolbarSession", () => {
  it("seeds focus on the first enabled button when the toolbar opens", () => {
    const states = enabled(3);
    states[0].disabled = true;
    const { setFocusedIndex } = setup({ states });
    expect(setFocusedIndex).toHaveBeenCalledWith(1);
    expect(useUIStore.getState().toolbarSessionFocusIndex).toBe(1);
  });

  it("closes the toolbar with a notice when nothing is enabled", () => {
    const info = vi.spyOn(imeToast, "info").mockImplementation(() => "id");
    const { setFocusedIndex } = setup({ states: disabled(2) });
    expect(setFocusedIndex).not.toHaveBeenCalled();
    expect(useUIStore.getState().universalToolbarVisible).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("restores the session's button on later renders while open", () => {
    const { rerender, setFocusedIndex, initialProps } = setup();
    setFocusedIndex.mockClear();
    useUIStore.setState({ toolbarSessionFocusIndex: 2 });
    rerender({ ...initialProps, states: enabled(3) });
    expect(setFocusedIndex).toHaveBeenCalledWith(2);
  });

  it("closes the dropdown without moving focus when hidden", () => {
    const { closeMenu } = setup({ visible: false });
    expect(closeMenu).toHaveBeenCalledWith(false);
  });

  it("records navigation into the session", () => {
    const { rerender, initialProps } = setup();
    rerender({ ...initialProps, focusedIndex: 2 });
    expect(useUIStore.getState().toolbarSessionFocusIndex).toBe(2);
  });

  it("hands focus back to the editor when the visible toolbar loses focus with focus inside it", () => {
    inner.focus();
    const { rerender, initialProps } = setup();
    expect(wysiwygFocus).not.toHaveBeenCalled();
    rerender({ ...initialProps, hasFocus: false });
    expect(wysiwygFocus).toHaveBeenCalledTimes(1);
  });

  it("leaves focus alone when it is already outside the toolbar", () => {
    setup({ hasFocus: false });
    expect(wysiwygFocus).not.toHaveBeenCalled();
  });
});
