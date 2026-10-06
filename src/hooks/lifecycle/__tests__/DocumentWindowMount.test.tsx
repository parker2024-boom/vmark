// DocumentWindowMount — the conditional-mount wrapper must run the
// document composite before the window composite and render nothing.
//
// The composites run for real. Only the Tauri event boundary is replaced, by a
// recorder that logs every listener registration in order — so "the document
// composite runs first" is observed as the document hooks' registrations
// (drag-drop) landing before the window hooks' (file watcher, close handling).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { WindowContext } from "@/contexts/WindowContext";

const boundary = vi.hoisted(() => ({
  label: "main",
  registered: [] as string[],
  detached: [] as string[],
}));

function register(name: string) {
  boundary.registered.push(name);
  return Promise.resolve(() => {
    boundary.detached.push(name);
  });
}

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string) => register(event)),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(() => ({
    onDragDropEvent: vi.fn(() => register("drag-drop")),
  })),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() => ({
    label: boundary.label,
    isFocused: vi.fn(() => Promise.resolve(true)),
    listen: vi.fn((event: string) => register(event)),
    emit: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    onDragDropEvent: vi.fn(() => register("drag-drop")),
  })),
  WebviewWindow: { getByLabel: vi.fn(() => Promise.resolve(null)) },
}));

import { DocumentWindowMount } from "../DocumentWindowMount";

function mount(label: string) {
  boundary.label = label;
  return render(
    <WindowContext.Provider value={{ windowLabel: label, isDocumentWindow: true }}>
      <DocumentWindowMount />
    </WindowContext.Provider>
  );
}

/** Registered by the document composite (useDragDropOpen). */
const DOCUMENT_EVENT = "drag-drop";
/** Registered by the window composite (useWindowFileWatcher, useWindowClose). */
const WINDOW_EVENTS = ["fs:changed", "menu:close"];
/** Registered only by the secondary-window Finder listener. */
const FINDER_EVENT = "app:open-file";

async function settled() {
  await waitFor(() => {
    for (const e of [DOCUMENT_EVENT, ...WINDOW_EVENTS]) {
      expect(boundary.registered).toContain(e);
    }
  });
}

beforeEach(() => {
  boundary.registered.length = 0;
  boundary.detached.length = 0;
});

describe("DocumentWindowMount", () => {
  it("mounts the document composite before the window composite", async () => {
    mount("main");
    await settled();

    const documentAt = boundary.registered.indexOf(DOCUMENT_EVENT);
    for (const e of WINDOW_EVENTS) {
      expect(documentAt).toBeLessThan(boundary.registered.indexOf(e));
    }
  });

  it("renders no visible DOM (pure lifecycle wiring)", async () => {
    const { container } = mount("main");
    await settled();
    expect(container).toBeEmptyDOMElement();
  });

  it("detaches its listeners on unmount and registers nothing afterwards", async () => {
    const { unmount } = mount("main");
    await settled();
    const before = [...boundary.registered];

    unmount();

    await waitFor(() => {
      for (const e of [DOCUMENT_EVENT, ...WINDOW_EVENTS]) {
        expect(boundary.detached).toContain(e);
      }
    });
    expect(boundary.registered).toEqual(before);
  });

  it("leaves the Finder listener to MainWindowRunners in the main window", async () => {
    mount("main");
    await settled();
    expect(boundary.registered).not.toContain(FINDER_EVENT);
  });

  it("mounts the Finder listener in a secondary document window", async () => {
    mount("doc-0");
    await settled();
    await waitFor(() => expect(boundary.registered).toContain(FINDER_EVENT));
  });
});
