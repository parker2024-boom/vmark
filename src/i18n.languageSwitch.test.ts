// WI-RA21.4 — the last requested language wins.
//
// src/i18n.ts follows `general.language` in the settings store. It skipped a
// request equal to the last COMMITTED language, so switching away and straight
// back — "ja", then "en" while Japanese was still loading — dropped the second
// request: Japanese finished loading and the UI stayed Japanese while the
// setting said English.
//
// The real i18n module (unmocked here), the real i18next and the real settings
// store; each case loads a fresh module graph so i18n subscribes to that store.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("@/i18n");

async function loadI18n() {
  vi.resetModules();
  localStorage.clear();
  // i18next is one instance per process (a node_modules singleton that module
  // resets do not re-evaluate): start every case from English.
  const { default: i18next } = await import("i18next");
  if (i18next.isInitialized) await i18next.changeLanguage("en");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  useSettingsStore.getState().updateGeneralSetting("language", "en");
  const { default: i18n } = await import("./i18n");
  const changes = vi.spyOn(i18n, "changeLanguage");
  /** The user picks `language` in Settings. */
  const choose = (language: string) => useSettingsStore.getState().updateGeneralSetting("language", language);
  /** Any other settings write — the store re-emits the language unchanged. */
  const touchOtherSetting = () => useSettingsStore.getState().updateGeneralSetting("tabSize", 4);
  /** Wait for every switch requested so far to settle. */
  const settled = async () => {
    await Promise.allSettled(changes.mock.results.map((r) => r.value as Promise<unknown>));
  };
  return { i18n, changes, choose, touchOtherSetting, settled };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("i18n follows the last requested language", () => {
  it("switching back to the current language while another is loading lands on the current one", async () => {
    const { i18n, choose, settled } = await loadI18n();
    expect(i18n.language).toBe("en");

    choose("ja"); // starts loading Japanese
    choose("en"); // back before it finishes
    await settled();

    expect(i18n.language).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("the last of several rapid switches wins", async () => {
    const { i18n, choose, settled } = await loadI18n();

    choose("ja");
    choose("zh-CN");
    choose("de");
    await settled();

    expect(i18n.language).toBe("de");
  });

  it("a repeated emission of the same language does not request it twice", async () => {
    const { changes, choose, touchOtherSetting, settled } = await loadI18n();

    choose("ko");
    touchOtherSetting(); // re-emits "ko" while it is still loading
    await settled();

    expect(changes.mock.calls.map((c) => c[0])).toEqual(["ko"]);
  });

  it("a switch that failed is retried by the next settings emission", async () => {
    const { changes, choose, touchOtherSetting, settled } = await loadI18n();
    changes.mockRejectedValueOnce(new Error("Missing locale: ./locales/ja/common.json"));

    choose("ja");
    await settled();
    touchOtherSetting();

    expect(changes.mock.calls.map((c) => c[0])).toEqual(["ja", "ja"]);
    await settled();
  });

  it("an unchanged language triggers no switch at all", async () => {
    const { changes, touchOtherSetting } = await loadI18n();

    touchOtherSetting();

    expect(changes).not.toHaveBeenCalled();
  });
});
