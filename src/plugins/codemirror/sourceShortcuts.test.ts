// @vitest-environment node
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { useShortcutsStore } from "@/stores/settingsStore";
import { bindPluginHostSettings } from "@/services/assembly/bindHostSettings";
import { buildSourceShortcutKeymap, getSourceBlockBounds } from "./sourceShortcuts";
import { bindHostSearch, resetHostSearch } from "@/plugins/shared/hostSearch";

// Shared mock state — must be hoisted so the vi.mock factory can close over it
const { runEditorActionMock } = vi.hoisted(() => ({
  runEditorActionMock: vi.fn(),
}));

// Formatting/editing shortcuts now route through the shared editor executor; spy
// on runEditorAction so tests can assert the shortcut dispatches the right action id.
// Fully mock (no importOriginal): the real module transitively imports the whole
// CodeMirror chain (sourceAdapter → codemirror/index), which this suite mocks
// partially — sourceShortcuts only consumes the runEditorAction export anyway.
vi.mock("@/services/editor/runEditorAction", () => ({
  runEditorAction: (...args: unknown[]) => runEditorActionMock(...args),
}));

vi.mock("@codemirror/commands", () => ({
  toggleBlockComment: vi.fn((_view: unknown) => true),
  selectLine: vi.fn((_view: unknown) => true),
}));

// Mock context detection so getSourceBlockBounds can be tested
vi.mock("@/plugins/sourceContextDetection/codeFenceDetection", () => ({
  getCodeFenceInfo: vi.fn(() => null),
}));
vi.mock("@/plugins/sourceContextDetection/tableDetection", () => ({
  getSourceTableInfo: vi.fn(() => null),
}));
vi.mock("@/plugins/sourceContextDetection/blockquoteDetection", () => ({
  getBlockquoteInfo: vi.fn(() => null),
}));
vi.mock("@/plugins/sourceContextDetection/listDetection", () => ({
  getListBlockBounds: vi.fn(() => null),
}));
vi.mock("@/utils/imeGuard", () => ({
  guardCodeMirrorKeyBinding: vi.fn((binding: unknown) => binding),
}));

function resetShortcuts() {
  bindPluginHostSettings();
  useShortcutsStore.setState({ customBindings: {} });
}

beforeEach(resetShortcuts);
afterEach(resetShortcuts);

// Minimal mock CodeMirror view
const mockView = {} as unknown as import("@codemirror/view").EditorView;

function getBinding(key: string) {
  const bindings = buildSourceShortcutKeymap();
  return bindings.find((b) => b.key === key);
}

describe("buildSourceShortcutKeymap", () => {
  it("uses custom shortcut bindings from the store", () => {
    useShortcutsStore.setState({ customBindings: { italic: "Alt-i" } });
    const keys = buildSourceShortcutKeymap().map((binding) => binding.key);

    expect(keys).toContain("Alt-i");
    expect(keys).not.toContain("Mod-i");
  });

  it("does NOT bind toggleSidebar — it is handled at window level", () => {
    // This test previously asserted the OPPOSITE, pinning a double-toggle:
    // toggleSidebar is scope:"global", the window view-keybindings own it, and
    // `shortcutDefinitions.ts` says so outright ("never the TipTap keymap, to
    // avoid double-toggle"). WYSIWYG obeyed that; Source bound it anyway, so
    // both handlers fired and the sidebar toggled twice — indistinguishable
    // from the shortcut not working.
    useShortcutsStore.setState({ customBindings: { toggleSidebar: "Alt-Mod-s" } } as never);
    const bindings = buildSourceShortcutKeymap();

    expect(bindings.find((b) => b.key === "Alt-Mod-s")).toBeUndefined();
  });

  it("sourceMode binding returns true without action (line 133)", () => {
    const shortcut = useShortcutsStore.getState().getShortcut("sourceMode");
    const binding = getBinding(shortcut);
    expect(binding).toBeDefined();
    const result = binding!.run!(mockView);
    expect(result).toBe(true);
  });

  it("toggleComment binding calls toggleBlockComment (line 151)", async () => {
    const cmCommands = await import("@codemirror/commands");
    const shortcut = useShortcutsStore.getState().getShortcut("toggleComment");
    const binding = getBinding(shortcut);
    expect(binding).toBeDefined();
    binding!.run!(mockView);
    expect(cmCommands.toggleBlockComment).toHaveBeenCalledWith(mockView);
  });

  it("bulletList binding dispatches bulletList through the editor executor", () => {
    runEditorActionMock.mockClear();
    const shortcut = useShortcutsStore.getState().getShortcut("bulletList");
    const binding = getBinding(shortcut);
    expect(binding).toBeDefined();
    const result = binding!.run!(mockView);
    expect(result).toBe(true);
    expect(runEditorActionMock).toHaveBeenCalledWith(
      "bulletList",
      expect.objectContaining({ windowLabel: expect.any(String) })
    );
  });

  it("orderedList binding dispatches orderedList through the editor executor", () => {
    runEditorActionMock.mockClear();
    const shortcut = useShortcutsStore.getState().getShortcut("orderedList");
    const binding = getBinding(shortcut);
    expect(binding).toBeDefined();
    const result = binding!.run!(mockView);
    expect(result).toBe(true);
    expect(runEditorActionMock).toHaveBeenCalledWith("orderedList", expect.any(Object));
  });

  it("taskList binding dispatches taskList through the editor executor", () => {
    runEditorActionMock.mockClear();
    const shortcut = useShortcutsStore.getState().getShortcut("taskList");
    const binding = getBinding(shortcut);
    expect(binding).toBeDefined();
    const result = binding!.run!(mockView);
    expect(result).toBe(true);
    expect(runEditorActionMock).toHaveBeenCalledWith("taskList", expect.any(Object));
  });

  it("selectLine binding calls selectLine from @codemirror/commands (line 189)", async () => {
    const cmCommands = await import("@codemirror/commands");
    const shortcut = useShortcutsStore.getState().getShortcut("selectLine");
    const binding = getBinding(shortcut);
    expect(binding).toBeDefined();
    binding!.run!(mockView);
    expect(cmCommands.selectLine).toHaveBeenCalledWith(mockView);
  });

  it("findReplace binding opens the host's find bar", () => {
    const open = vi.fn();
    bindHostSearch({ open });
    try {
      const shortcut = useShortcutsStore.getState().getShortcut("findReplace");
      const binding = getBinding(shortcut);
      expect(binding).toBeDefined();
      expect(binding!.run!(mockView)).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      resetHostSearch();
    }
  });
});

describe("getSourceBlockBounds", () => {
  it("returns null when no block is found", async () => {
    // All context detection mocks return null → should return null
    const { getCodeFenceInfo } = await import("@/plugins/sourceContextDetection/codeFenceDetection");
    const { getSourceTableInfo } = await import("@/plugins/sourceContextDetection/tableDetection");
    const { getBlockquoteInfo } = await import("@/plugins/sourceContextDetection/blockquoteDetection");
    const { getListBlockBounds } = await import("@/plugins/sourceContextDetection/listDetection");
    vi.mocked(getCodeFenceInfo).mockReturnValue(null);
    vi.mocked(getSourceTableInfo).mockReturnValue(null);
    vi.mocked(getBlockquoteInfo).mockReturnValue(null);
    vi.mocked(getListBlockBounds).mockReturnValue(null);

    const result = getSourceBlockBounds(mockView);
    expect(result).toBeNull();
  });
});
