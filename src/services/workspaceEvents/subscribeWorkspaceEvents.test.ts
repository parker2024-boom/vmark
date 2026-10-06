// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const listen = vi.fn(async () => () => {});
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...a) }));

import { _resetWorkspaceEventSources, subscribeWorkspaceEvents } from "@/services/workspaceEvents/subscribeWorkspaceEvents";

afterEach(() => {
  _resetWorkspaceEventSources();
  listen.mockClear();
});

describe("workspace event source registry", () => {
  it("attaches exactly one fs listener per window, regardless of subscriber count", async () => {
    const off1 = subscribeWorkspaceEvents("main", () => {});
    const off2 = subscribeWorkspaceEvents("main", () => {});
    await Promise.resolve();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith("fs:changed", expect.any(Function), expect.anything());
    off1();
    off2();
  });

  // WI-RA11.1 — the watcher addresses its batches to the owning window. A
  // listener registered without a target would still be woken by every other
  // window's watcher.
  it("listens only for events addressed to its own window", async () => {
    subscribeWorkspaceEvents("doc-2", () => {});
    await Promise.resolve();
    expect(listen).toHaveBeenCalledWith("fs:changed", expect.any(Function), {
      target: { kind: "WebviewWindow", label: "doc-2" },
    });
  });

  it("returns a working unsubscribe", () => {
    const off = subscribeWorkspaceEvents("main", () => {});
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });

  it("creates an independent source per window", async () => {
    subscribeWorkspaceEvents("main", () => {});
    subscribeWorkspaceEvents("second", () => {});
    await Promise.resolve();
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it("re-attaches after the source is reset", async () => {
    subscribeWorkspaceEvents("main", () => {});
    await Promise.resolve();
    _resetWorkspaceEventSources();
    subscribeWorkspaceEvents("main", () => {});
    await Promise.resolve();
    expect(listen).toHaveBeenCalledTimes(2);
  });
});
