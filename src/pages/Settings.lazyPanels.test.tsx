// WI-RA18.9 — the Settings window loads a section's panel when the section is
// shown, not every panel before the first paint; search waits for all of its
// panels, so its row count is never taken over a half-loaded stack.
//
// Renders the real page against the real store and the global Tauri mocks. The
// panel cache lives for the module's lifetime, so the tests run in the order
// they are written: the first one is the only one that sees a cold cache.
//
// Waiting: a panel's first import transforms its whole module graph, which on
// a busy machine outlasts any `findBy*` budget. The tests therefore await the
// import itself — `settingsPanels.load` joins the request the page already
// made — and only then read the DOM. A page that never asked for the panel
// still fails: it is not subscribed, so nothing would be on screen.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { SettingsPage } from "./Settings";
import { SEARCHABLE_PANEL_IDS, settingsPanels, type Section } from "./settings/panels";
import { useSettingsStore } from "@/stores/settingsStore";

const LIST_COMMANDS = new Set(["mcp_config_diagnose", "list_available_shells", "list_models"]);
// The dev section ships visible, so search stacks Advanced as well.
const SEARCH_STACK: Section[] = [...SEARCHABLE_PANEL_IDS, "advanced"];

function startOn(section: string): void {
  window.history.replaceState(null, "", `/?section=${section}`);
}

/** Wait for the imports the page has under way for `ids`, and the render after. */
async function arrived(ids: readonly Section[]): Promise<void> {
  await act(() => settingsPanels.load(ids));
}

async function renderOnEditor(): Promise<void> {
  render(<SettingsPage />);
  await arrived(["editor"]);
}

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
  startOn("editor");
  // Search mounts every panel, and these commands answer with a list.
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(LIST_COMMANDS.has(command) ? [] : undefined),
  );
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.mocked(invoke).mockImplementation(() => Promise.resolve());
});

describe("SettingsPage — panels load per section", () => {
  it("opens with only the panel of the section it opens on", async () => {
    render(<SettingsPage />);
    expect(screen.queryByText("Editor Width")).not.toBeInTheDocument();

    await arrived(["editor"]);

    expect(screen.getByText("Editor Width")).toBeInTheDocument();
    for (const other of ["appearance", "terminal", "markdown", "integrations"] as const) {
      expect(settingsPanels.peek([other])).toBeNull();
    }
  });

  it("keeps the previous panel up while the selected section's panel loads, then swaps", async () => {
    const user = userEvent.setup();
    await renderOnEditor();

    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByText("Editor Width")).toBeInTheDocument();

    await arrived(["terminal"]);

    expect(screen.getByText("Accessibility")).toBeInTheDocument();
    expect(screen.queryByText("Editor Width")).not.toBeInTheDocument();
  });

  it("shows search results once every searchable panel is loaded, never a false 'no results'", async () => {
    const user = userEvent.setup();
    await renderOnEditor();

    await user.type(screen.getByRole("searchbox"), "width");

    // Most of the stack is still on its way: nothing is drawn, and above all
    // nothing is reported.
    expect(document.querySelectorAll("[data-settings-panel]")).toHaveLength(0);
    expect(screen.queryByText(/No settings match/)).not.toBeInTheDocument();

    await arrived(SEARCH_STACK);

    expect(document.querySelectorAll("[data-settings-panel]")).toHaveLength(SEARCH_STACK.length);
    expect(screen.queryByText(/No settings match/)).not.toBeInTheDocument();
    const visibleRows = document.querySelectorAll('[data-setting-row][data-search-visible="true"]');
    expect(visibleRows.length).toBeGreaterThan(0);
  });

  it("reports no results for a query nothing matches", async () => {
    const user = userEvent.setup();
    await renderOnEditor();

    await user.type(screen.getByRole("searchbox"), "zzzqqq");
    await arrived(SEARCH_STACK);

    expect(screen.getByText(/No settings match/)).toBeInTheDocument();
  });
});
