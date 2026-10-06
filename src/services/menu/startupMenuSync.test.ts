// @vitest-environment node
// WI-RA14D.1 — on import, startup menu sync sets the Rust locale and rebuilds the
// native menu only when the saved language is not English, and a failure is
// logged instead of escaping as an unhandled rejection.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

const menu = vi.hoisted(() => ({
  rebuildNativeMenu: vi.fn<() => Promise<void>>(),
  menuSyncWarn: vi.fn(),
}));

// The rebuild pipeline has its own suite (rebuildNativeMenu.test.ts).
vi.mock("@/services/menu/rebuildNativeMenu", () => ({
  rebuildNativeMenu: menu.rebuildNativeMenu,
}));
vi.mock("@/utils/debug", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/debug")>()),
  menuSyncWarn: menu.menuSyncWarn,
}));

const invokeMock = vi.mocked(invoke);

/** Import the module fresh, with `language` saved in a fresh settings store. */
async function loadWithLanguage(language: string): Promise<void> {
  vi.resetModules();
  const { useSettingsStore } = await import("@/stores/settingsStore");
  useSettingsStore.setState((s) => ({ general: { ...s.general, language } }));
  await import("./startupMenuSync");
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  menu.rebuildNativeMenu.mockReset();
  menu.rebuildNativeMenu.mockResolvedValue(undefined);
  menu.menuSyncWarn.mockReset();
});

describe("startupMenuSync", () => {
  it("leaves the English menu alone", async () => {
    await loadWithLanguage("en");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(menu.rebuildNativeMenu).not.toHaveBeenCalled();
  });

  it("treats an empty saved language as nothing to sync", async () => {
    await loadWithLanguage("");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(menu.rebuildNativeMenu).not.toHaveBeenCalled();
  });

  it.each(["zh-CN", "ja", "de"])(
    "sets the Rust locale to %s first, then rebuilds the menu",
    async (language) => {
      await loadWithLanguage(language);
      expect(invokeMock).toHaveBeenCalledWith("set_locale", { locale: language });
      await vi.waitFor(() => expect(menu.rebuildNativeMenu).toHaveBeenCalledTimes(1));
      expect(invokeMock.mock.invocationCallOrder[0]).toBeLessThan(
        menu.rebuildNativeMenu.mock.invocationCallOrder[0],
      );
    },
  );

  it("does not rebuild when setting the locale fails, and logs why", async () => {
    const failure = new Error("unknown locale");
    invokeMock.mockRejectedValue(failure);
    await loadWithLanguage("zh-CN");

    await vi.waitFor(() =>
      expect(menu.menuSyncWarn).toHaveBeenCalledWith("rebuild failed:", failure),
    );
    expect(menu.rebuildNativeMenu).not.toHaveBeenCalled();
  });

  it("logs a failed rebuild", async () => {
    const failure = new Error("rebuild_menu failed");
    menu.rebuildNativeMenu.mockRejectedValue(failure);
    await loadWithLanguage("ja");

    await vi.waitFor(() =>
      expect(menu.menuSyncWarn).toHaveBeenCalledWith("rebuild failed:", failure),
    );
  });
});
