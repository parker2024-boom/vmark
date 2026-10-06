// WI-RA19.5 — a title-bar rename that cannot happen tells the user why. A name
// collision and a failed rename were only written to the debug log, so the
// input stayed in edit mode with no explanation. The messages are the ones the
// tab and sidebar renames show.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { RenameOutcome } from "@/services/persistence/renameFile";

const mockRenameService = vi.fn();
vi.mock("@/services/persistence/renameFile", () => ({
  renameFile: (...args: unknown[]) => mockRenameService(...args),
}));

const showError = vi.hoisted(() => vi.fn(async (_title: string) => undefined));
vi.mock("@/services/dialogs/errorDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/dialogs/errorDialog")>()),
  showError,
}));

import { useTitleBarRename } from "./useTitleBarRename";

async function rename(o: RenameOutcome, newName = "taken"): Promise<boolean> {
  mockRenameService.mockResolvedValue(o);
  const { result } = renderHook(() => useTitleBarRename());
  let ok = true;
  await act(async () => {
    ok = await result.current.renameFile("/docs/notes.md", newName);
  });
  return ok;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("title-bar rename feedback", () => {
  it("shows the file-exists message on a name collision and stays in edit mode", async () => {
    const ok = await rename({ status: "exists", name: "已存在.md", isFile: true });
    expect(ok).toBe(false);
    expect(showError).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledWith("A file named “已存在.md” already exists.");
  });

  it("shows the folder-exists message when the name belongs to a folder", async () => {
    await rename({ status: "exists", name: "docs", isFile: false });
    expect(showError).toHaveBeenCalledWith("A folder named “docs” already exists.");
  });

  it("shows the rename-failed message when the rename itself fails", async () => {
    const ok = await rename({ status: "error", error: new Error("EACCES") }, "locked");
    expect(ok).toBe(false);
    expect(showError).toHaveBeenCalledWith("Failed to rename “locked”.");
  });

  it.each<RenameOutcome>([
    { status: "renamed", newPath: "/docs/new.md" },
    { status: "unchanged", path: "/docs/notes.md" },
  ])("shows nothing when the rename outcome is $status", async (o) => {
    expect(await rename(o)).toBe(true);
    expect(showError).not.toHaveBeenCalled();
  });
});
