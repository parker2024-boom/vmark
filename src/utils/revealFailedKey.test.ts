// @vitest-environment node
// WI-RA20.3 — the "could not reveal" message names the platform's own file
// manager: Finder only on macOS, Explorer on Windows, a generic file manager
// elsewhere. It used to say "Finder" on every platform.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { revealInFileManagerKey } from "./pathUtils";
import { revealFailedKey } from "./revealFailedKey";

const localesDir = path.resolve(import.meta.dirname, "../locales");

/** The English message for a `dialog:` key, read from the bundle: utils tests stay off the i18n runtime. */
function english(key: string): string {
  const bundle = JSON.parse(readFileSync(path.join(localesDir, "en", "dialog.json"), "utf8")) as Record<string, string>;
  return bundle[key.replace(/^dialog:/, "")] ?? key;
}

function onPlatform(platform: string) {
  vi.stubGlobal("navigator", { platform });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("revealFailedKey", () => {
  it.each([
    ["MacIntel", "Finder"],
    ["Win32", "Explorer"],
    ["Linux x86_64", "file manager"],
  ])("on %s names %s", (platform, manager) => {
    onPlatform(platform);
    expect(english(revealFailedKey())).toContain(manager);
  });

  it.each(["Win32", "Linux x86_64", ""])("never says Finder on %j", (platform) => {
    onPlatform(platform);
    expect(english(revealFailedKey())).not.toContain("Finder");
  });

  it("follows the same platform rule as the reveal label", () => {
    const seen = new Map<string, string>();
    for (const platform of ["MacIntel", "Win32", "Linux x86_64", ""]) {
      onPlatform(platform);
      const label = revealInFileManagerKey();
      const failure = revealFailedKey();
      expect(seen.get(label) ?? failure).toBe(failure);
      seen.set(label, failure);
    }
    expect(new Set(seen.values()).size).toBe(3);
  });

  it("has a translated message for every platform in every locale", () => {
    const locales = readdirSync(localesDir).filter((name) => /^[a-z]{2}(-[A-Z]{2})?$/.test(name));
    expect(locales.length).toBeGreaterThanOrEqual(10);
    const keys = ["MacIntel", "Win32", "Linux"].map((platform) => {
      onPlatform(platform);
      return revealFailedKey().replace(/^dialog:/, "");
    });
    for (const locale of locales) {
      const bundle = JSON.parse(readFileSync(path.join(localesDir, locale, "dialog.json"), "utf8")) as Record<string, string>;
      for (const key of keys) expect(bundle[key], `${locale} ${key}`).toMatch(/\S/);
    }
  });
});
