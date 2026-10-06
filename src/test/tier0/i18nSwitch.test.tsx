// WI-RA14C.5 — switching the interface language, from the Settings picker (and
// from another window's settings write) to what the user gets: the strings a
// real page renders, the persisted setting, `<html lang>`, and the locale the
// Rust side is given before it rebuilds the native menu.
//
// REAL: i18next and react-i18next — the two global stand-ins in
// src/test/setup.ts are switched off for this file only — the app's `@/i18n`
// module with its lazily imported locale bundles and its settings
// subscription, the settings store, `useSettingsSync`, the `LanguageSettings`
// page and `rebuildNativeMenu`. FAKED: `@tauri-apps/api/core` only, as a Rust
// side that remembers the locale it was last given and the locale each native
// menu was built in. Expected strings are read from the locale bundles, never
// typed here. Bundles arrive through real dynamic imports, so every wait is on
// a rendered or stored outcome, never on a clock.
//
// Not asserted here: a write back to the language already committed while
// another locale is still loading. The subscriber in src/i18n.ts treats that
// write as a no-op, so there is no outcome this file could pin as correct.
import { Suspense } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.unmock("react-i18next");
vi.unmock("@/i18n");
vi.mock("@tauri-apps/api/core", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.coreModule();
});

import i18n from "@/i18n";
import { LanguageSettings } from "@/pages/settings/LanguageSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSettingsSync } from "@/hooks/useSettingsSync";
import { statefulFs } from "@/test/statefulFsFake";
import en from "@/locales/en/settings.json";
import zhCN from "@/locales/zh-CN/settings.json";
import ja from "@/locales/ja/settings.json";
import ko from "@/locales/ko/settings.json";
import de from "@/locales/de/settings.json";

/** The picker's own label: a string the page renders through `t()`, per locale. */
const KEY = "language.interfaceLanguage.label";
const LABEL = { en: en[KEY], "zh-CN": zhCN[KEY], ja: ja[KEY], ko: ko[KEY], de: de[KEY] } as const;
type Locale = keyof typeof LABEL;

/** The Rust side: the locale it was last given, and the locale each native menu was built in. */
const rust = { locale: "en", menus: [] as string[] };

/** The Settings window as the app composes it for this flow. */
function SettingsWindow() {
  useSettingsSync();
  return (
    <Suspense fallback={null}>
      <LanguageSettings />
    </Suspense>
  );
}

/** Mount the page and wait for its English strings. */
async function openSettings() {
  render(<SettingsWindow />);
  await screen.findByLabelText(LABEL.en);
  return userEvent.setup();
}

/** The language picker, found by its label in `locale` — so finding it proves the page is in that language. */
const pickerIn = (locale: Locale) => screen.findByLabelText<HTMLSelectElement>(LABEL[locale]);

/** What `useSettingsSync` receives when another window persists a new language. */
function otherWindowWrites(language: string): void {
  const general = { ...useSettingsStore.getState().general, language };
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: "vmark-settings", newValue: JSON.stringify({ state: { general } }) }),
    );
  });
}

const storedLanguage = () => useSettingsStore.getState().general.language;

beforeEach(async () => {
  statefulFs.reset();
  rust.locale = "en";
  rust.menus = [];
  statefulFs.stubCommand("set_locale", ({ locale }) => void (rust.locale = String(locale)));
  statefulFs.stubCommand("rebuild_menu", () => void rust.menus.push(rust.locale));
  // The rest of the menu rebuild: dynamic submenus, irrelevant to the language.
  for (const command of ["refresh_genies_menu", "update_recent_files", "update_recent_workspaces"]) {
    statefulFs.stubCommand(command, () => undefined);
  }
  // Every case starts settled in English: the setting, and the i18n instance.
  useSettingsStore.getState().updateGeneralSetting("language", "en");
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("picking a language in Settings", () => {
  it("translates the page, persists the choice, sets <html lang> and tells Rust — for a CJK locale, a second one, and back", async () => {
    expect(new Set(Object.values(LABEL)).size).toBe(Object.keys(LABEL).length); // the oracle can tell locales apart
    const user = await openSettings();
    let shown: Locale = "en";

    for (const next of ["zh-CN", "de", "en"] as const) {
      await user.selectOptions(await pickerIn(shown), next);

      const picker = await pickerIn(next);
      expect(screen.queryByText(LABEL[shown])).toBeNull();
      // The setting is persisted last, once Rust and the native menu followed.
      await waitFor(() => expect(storedLanguage()).toBe(next));
      expect(picker).toHaveValue(next);
      expect(document.documentElement.lang).toBe(next);
      // Rust had the new locale before it built the menu.
      expect(rust.locale).toBe(next);
      expect(rust.menus.at(-1)).toBe(next);
      shown = next;
    }

    expect(rust.menus).toEqual(["zh-CN", "de", "en"]);
  });

  it("refuses a second pick while the first is still being applied, and ends on the first everywhere", async () => {
    let finishFirst: (() => void) | null = null;
    statefulFs.stubCommand(
      "set_locale",
      ({ locale }) =>
        new Promise<void>((resolve) => {
          finishFirst = () => {
            rust.locale = String(locale);
            resolve();
          };
        }),
    );
    const user = await openSettings();

    await user.selectOptions(await pickerIn("en"), "ja");
    const picker = await pickerIn("ja"); // strings switched; Rust has not answered yet
    await waitFor(() => expect(finishFirst).not.toBeNull());
    await user.selectOptions(picker, "de");
    act(() => finishFirst?.());

    await waitFor(() => expect(storedLanguage()).toBe("ja"));
    expect(await pickerIn("ja")).toHaveValue("ja");
    expect(document.documentElement.lang).toBe("ja");
    expect(rust).toEqual({ locale: "ja", menus: ["ja"] });
  });

  it("a Rust-side failure puts the page, <html lang> and Rust back, persists nothing, and is reported", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    statefulFs.stubCommand("set_locale", ({ locale }) =>
      locale === "ja" ? Promise.reject(new Error("locale table missing")) : void (rust.locale = String(locale)),
    );
    const user = await openSettings();

    await user.selectOptions(await pickerIn("en"), "ja");

    await waitFor(() => expect(rust.menus).toEqual(["en"])); // the revert rebuilt the menu
    expect(await pickerIn("en")).toHaveValue("en");
    expect(screen.queryByText(LABEL.ja)).toBeNull();
    expect(storedLanguage()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(rust.locale).toBe("en");
    expect(warned).toHaveBeenCalledWith(
      "[i18n]",
      expect.stringContaining("Failed to switch language"),
      expect.objectContaining({ message: "locale table missing" }),
    );
  });
});

describe("a language written by another window", () => {
  it("re-translates this window and its picker follows", async () => {
    await openSettings();

    otherWindowWrites("ja");

    expect(await pickerIn("ja")).toHaveValue("ja");
    expect(screen.queryByText(LABEL.en)).toBeNull();
    expect(storedLanguage()).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
  });

  it("two writes in quick succession end on the last one, even though the first one's bundles arrive later", async () => {
    await openSettings();
    otherWindowWrites("zh-CN"); // load zh-CN once, so that switching to it below is immediate
    await pickerIn("zh-CN");
    otherWindowWrites("en");
    await pickerIn("en");

    otherWindowWrites("ko"); // never loaded: its bundles are still on their way…
    otherWindowWrites("zh-CN"); // …when the newer write lands
    const namespaces = [i18n.options.ns ?? []].flat();
    await waitFor(() => expect(namespaces.every((ns) => i18n.hasResourceBundle("ko", ns))).toBe(true));

    expect(await pickerIn("zh-CN")).toHaveValue("zh-CN");
    expect(screen.queryByText(LABEL.ko)).toBeNull();
    expect(i18n.language).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("an unknown language falls back to English strings without throwing, and the next real one still applies", async () => {
    await openSettings();
    otherWindowWrites("zh-CN");
    await pickerIn("zh-CN");

    otherWindowWrites("xx-YY");

    await pickerIn("en"); // English strings, not Chinese and not raw keys
    expect(screen.queryByText(LABEL["zh-CN"])).toBeNull();
    expect(screen.queryByText(KEY)).toBeNull();

    otherWindowWrites("de");
    expect(await pickerIn("de")).toHaveValue("de");
  });
});
