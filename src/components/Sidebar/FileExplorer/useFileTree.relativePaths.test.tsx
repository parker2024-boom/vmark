// WI-RA11.6 — the explorer rebuilds node ids from the listing's root prefix and
// each node's name: the walker no longer repeats the absolute path per node.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock("@/services/workspaceEvents/subscribeWorkspaceEvents", () => ({
  subscribeWorkspaceEvents: () => () => {},
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onFocusChanged: async () => () => {} }),
}));

import { useFileTree } from "./useFileTree";

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useFileTree — node ids from the compact listing", () => {
  it("gives every node its absolute path as its id", async () => {
    invokeMock.mockResolvedValue({
      rootPrefix: "/root/",
      separator: "/",
      entries: [
        {
          name: "笔记",
          isDirectory: true,
          isHidden: false,
          children: [{ name: "第一章.md", isDirectory: false, isHidden: false }],
        },
        { name: "readme.md", isDirectory: false, isHidden: false },
      ],
      truncated: false,
    });

    const { result } = renderHook(() => useFileTree("/root", { showAllFiles: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(result.current.error).toBeNull();
    expect(result.current.tree.map((n) => n.id)).toEqual(["/root/笔记", "/root/readme.md"]);
    expect(result.current.tree[0].children?.map((n) => n.id)).toEqual(["/root/笔记/第一章.md"]);
  });

  it("reports a listing without a root prefix as a failed listing, not an empty tree", async () => {
    invokeMock.mockResolvedValue({ entries: [{ name: "a.md", isDirectory: false, isHidden: false }], truncated: false });

    const { result } = renderHook(() => useFileTree("/root", { showAllFiles: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(result.current.tree).toEqual([]);
    expect(result.current.error).toMatch(/tree listing/);
  });
});
