/**
 * Journey: i18n-switching
 *
 * Changing the interface language must re-translate a window that is already
 * open — no reload, no restart — and changing it back must bring the original
 * strings back. jsdom can prove the wiring (src/test/tier0/i18nSwitch.test.tsx
 * does); only the live app proves that the locale bundles really arrive through
 * the running module graph and that mounted chrome re-renders with them.
 *
 * HOW THE LANGUAGE IS CHANGED. Through the app's own cross-window settings
 * path: `general.language` is written into the persisted settings and the
 * `storage` event a second window would produce is dispatched
 * (e2e/lib/settingsPatch.mjs → src/hooks/useSettingsSync.ts → settings store →
 * the subscriber in src/i18n.ts → `i18n.changeLanguage`). That is exactly what
 * the document window receives when the user picks a language in the Settings
 * window. The picker itself lives in that other webview, which this suite does
 * not drive, so the picker, the Rust `set_locale` call and the native-menu
 * rebuild are NOT covered here (the jsdom flow asserts them). The native menu
 * therefore keeps its language throughout, and there is nothing native to put
 * back.
 *
 * WHAT IS OBSERVED. The find bar's chrome — both input placeholders and the
 * close button's accessible name — rendered by FindBar.tsx through
 * `t("findbar.…")` in the `editor` namespace, plus `<html lang>`, which
 * src/i18n.ts sets on every language change. The bar is opened with the real
 * `menu:find-replace` event; it is the one piece of translated chrome a journey
 * can summon deterministically (the status bar is user-hideable and the bar
 * displaces it). Expected strings are READ from src/locales/<lang>/editor.json
 * in this Node process at run time, following the app's own fallback chain, so
 * no translation is hardcoded and the oracle moves with the bundles.
 *
 * WAITS — all `poll()`:
 *  - target strings: `changeLanguage` first imports every loaded namespace of
 *    the new locale from the dev server, then react-i18next re-renders; the
 *    budget is generous because a first load is several module requests;
 *  - original strings in `finally`: the same mechanism in reverse (those
 *    bundles are already loaded, so it is quick).
 *
 * SAFETY. The only setting touched is `general.language`, and it is restored in
 * `finally` presence-faithfully (a key that was absent is removed again, as
 * rail.mjs does), then the UI is polled until the original strings are back.
 * The restore is retried once through the other language: src/i18n.ts ignores
 * a write that returns to the language it last committed while a newer one is
 * still loading, so a journey that failed mid-switch could otherwise leave the
 * window in the target language. Find-bar and formatting-toolbar visibility are
 * put back, the scratch tab (there only so that a document tab — not a browser
 * tab, which has no find bar — is active) is discarded, nothing is written to
 * disk and no dialog is raised.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { evalJs } from "../lib/bridge.mjs";
import { withTabRestore, createScratchTab, emitMenu, poll } from "../lib/vmark.mjs";
import { patchPersistedSettings, readPersistedSettingsSection } from "../lib/settingsPatch.mjs";

const LOCALES_DIR = fileURLToPath(new URL("../../src/locales/", import.meta.url));
const NAMESPACE = "editor";
/** The find bar's translated chrome, in the order `readChrome` returns it. */
const KEYS = ["findbar.find.placeholder", "findbar.replace.placeholder", "findbar.close"];
/** Locales to switch to, in order of preference; the first usable one wins. */
const CANDIDATES = ["zh-CN", "ja", "de"];
/** A first load of a locale is several module requests to the dev server. */
const SWITCH_TIMEOUT_MS = 20000;

/** src/i18n.ts `fallbackLng`: zh-TW → zh-CN → en; every other language → en. */
const fallbackChain = (lang) => (lang === "zh-TW" ? ["zh-TW", "zh-CN", "en"] : [lang, "en"]);

/** One shipped bundle, or null when that locale does not ship it. */
async function bundle(lang, ns) {
  try {
    return JSON.parse(await readFile(join(LOCALES_DIR, lang, `${ns}.json`), "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** The strings the app shows for KEYS under `lang`, resolved the way i18next resolves them. */
async function expectedStrings(lang) {
  const bundles = [];
  for (const candidate of fallbackChain(lang)) bundles.push(await bundle(candidate, NAMESPACE));
  return KEYS.map((key) => {
    const hit = bundles.find((b) => typeof b?.[key] === "string");
    if (!hit) throw new Error(`no ${NAMESPACE}:${key} in any of: ${fallbackChain(lang).join(", ")}`);
    return hit[key];
  });
}

/** What the window shows right now. */
function readChrome(client) {
  return evalJs(
    client,
    `(() => {
       const bar = document.querySelector('.find-bar');
       const inputs = bar ? [...bar.querySelectorAll('.find-bar-input')] : [];
       return {
         open: !!bar,
         toolbar: !!document.querySelector('.universal-toolbar'),
         htmlLang: document.documentElement.lang,
         strings: [
           inputs[0]?.getAttribute('placeholder') ?? null,
           inputs[1]?.getAttribute('placeholder') ?? null,
           bar?.querySelector('.find-bar-close')?.getAttribute('aria-label') ?? null,
         ],
       };
     })()`
  );
}

const sameStrings = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

/** Write `general.language` through the app's cross-window settings path. */
const writeLanguage = (client, language) => patchPersistedSettings(client, "general", { language });

export default {
  name: "i18n-switching",

  async run(client, ctx) {
    const general = await readPersistedSettingsSection(client, "general");
    const hadKey = Boolean(general && Object.prototype.hasOwnProperty.call(general, "language"));
    const liveLang = await evalJs(client, `document.documentElement.lang`);
    const original = hadKey ? general.language : liveLang;
    if (typeof original !== "string" || original === "") {
      throw new Error(`cannot tell the current UI language (persisted: ${JSON.stringify(general?.language)}, <html lang>: ${JSON.stringify(liveLang)})`);
    }
    const originalStrings = await expectedStrings(original);

    // A target that ships its own bundle and differs from the original in
    // EVERY observed string — otherwise "translated" could not be told from
    // "unchanged".
    let target = null;
    let targetStrings = null;
    for (const candidate of CANDIDATES) {
      if (candidate === original) continue;
      const own = await bundle(candidate, NAMESPACE);
      if (!own || !KEYS.every((key, i) => typeof own[key] === "string" && own[key] !== originalStrings[i])) continue;
      target = candidate;
      targetStrings = KEYS.map((key) => own[key]);
      break;
    }
    if (!target) throw new Error(`no candidate locale (${CANDIDATES.join(", ")}) differs from ${original} in all of: ${KEYS.join(", ")}`);
    ctx.log(`current language ${original} (${hadKey ? "persisted" : "from <html lang>; not persisted"}) → switching to ${target}`);

    await withTabRestore(client, async ({ track }) => {
      const scratch = await createScratchTab(client);
      track(scratch.id);

      const initial = await readChrome(client);
      let journeyError = null;
      let languageWritten = false;
      try {
        if (!initial.open) await emitMenu(client, "find-replace", ctx.windowLabel);
        await poll(
          () => readChrome(client),
          (c) => c.open && sameStrings(c.strings, originalStrings),
          `the find bar to show its ${original} strings ${JSON.stringify(originalStrings)}`
        );

        languageWritten = true; // set BEFORE the write: a failure between the write and its event must still restore
        await writeLanguage(client, target);
        const switched = await poll(
          () => readChrome(client),
          (c) => sameStrings(c.strings, targetStrings) && c.htmlLang === target,
          `the find bar to show its ${target} strings ${JSON.stringify(targetStrings)} and <html lang="${target}">`,
          { timeoutMs: SWITCH_TIMEOUT_MS, intervalMs: 200 }
        );
        const persisted = (await readPersistedSettingsSection(client, "general"))?.language;
        if (persisted !== target) throw new Error(`UI switched to ${target} but the persisted language is ${JSON.stringify(persisted)}`);
        ctx.log(`${target}: ${JSON.stringify(switched.strings)}, <html lang="${switched.htmlLang}">`);
      } catch (err) {
        journeyError = err;
      }

      // Restore. Loud when the journey itself passed; logged otherwise, with
      // the journey's own error kept primary.
      const restoreErrors = [];
      const restore = async (label, fn) => {
        try {
          await fn();
        } catch (err) {
          restoreErrors.push(`${label}: ${err?.message ?? err}`);
        }
      };
      await restore("the interface language", async () => {
        if (!languageWritten) return;
        const slow = { timeoutMs: SWITCH_TIMEOUT_MS, intervalMs: 200 };
        // With the bar gone there are no strings to read; `<html lang>` still
        // says whether the window left the target language.
        const backToOriginal = () =>
          poll(
            () => readChrome(client),
            (c) => (c.open ? sameStrings(c.strings, originalStrings) : c.htmlLang !== target),
            `the window to show its ${original} strings again`,
            slow
          );
        await writeLanguage(client, original);
        try {
          await backToOriginal();
        } catch {
          // The write was ignored (see the header). Once the target has
          // finished loading it is the committed language, so writing it again
          // changes nothing and the write back to the original is then honoured.
          await poll(() => readChrome(client), (c) => c.htmlLang === target, `the late ${target} switch to land before retrying`, slow);
          await writeLanguage(client, target);
          await writeLanguage(client, original);
          await backToOriginal();
        }
        // Presence-faithful: a key that was not persisted before is removed again.
        if (!hadKey) await patchPersistedSettings(client, "general", {}, { deleteKeys: ["language"] });
        ctx.log(`language restored to ${original}`);
      });
      await restore("find-bar visibility", async () => {
        const now = await readChrome(client);
        if (now.open && !initial.open) {
          // The close button, not the menu toggle: it also gives the status bar
          // its lane back (FindBar.tsx handleClose).
          await evalJs(client, `(document.querySelector('.find-bar .find-bar-close')?.click(), true)`);
        } else if (!now.open && initial.open) {
          await emitMenu(client, "find-replace", ctx.windowLabel);
        }
        await poll(() => readChrome(client), (c) => c.open === initial.open, "find bar visibility to be what it was");
      });
      await restore("the formatting toolbar", async () => {
        // Opening the find bar hides it (useSearchCommands); it is a toggle.
        if (!initial.toolbar || (await readChrome(client)).toolbar) return;
        await emitMenu(client, "universal-toolbar", ctx.windowLabel);
        await poll(() => readChrome(client), (c) => c.toolbar, "the formatting toolbar to be shown again");
      });

      for (const message of restoreErrors) ctx.log(`restore failed — ${message}`);
      if (journeyError) throw journeyError;
      if (restoreErrors.length > 0) throw new Error(`state not restored: ${restoreErrors.join("; ")}`);
    });
  },
};
