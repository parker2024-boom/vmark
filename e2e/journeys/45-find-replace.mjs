/**
 * Journey: find-replace
 *
 * `find-bar` (07) proves the bar opens with its controls and closes on Escape.
 * This journey proves the bar WORKS: a query typed into the real find input is
 * counted in the bar and highlighted in the editor, and one click on the real
 * Replace All button rewrites every occurrence — in a heading, a paragraph and
 * a list item — in the rendered document AND in the markdown Source mode
 * serializes from it.
 *
 * What is REAL: the document is placed through the app's own
 * `vmark.document.write` path; the bar is opened by the `menu:find-replace`
 * event the native menu emits (useSearchCommands → uiStore search slice); the
 * query and the replacement go through the bar's own `<input>`s (native value
 * setter + `input` event, which is what React's onChange listens to — the same
 * driving journeys 22–24 use for the omnibox); Replace All is a click on the
 * bar's button; the search itself is the production ProseMirror plugin
 * (src/plugins/search/tiptap.ts + replaceActions.ts). What is NOT covered: the
 * single-match Replace button and Source mode's own CodeMirror search — Source
 * mode is only READ here, to see the replaced markdown.
 *
 * WHY THE CONTENT LOOKS THE WAY IT DOES. The bar's Match Case / Whole Word /
 * Regex toggles are user state the journey must not flip. The needle is
 * therefore lowercase alphanumerics, always a whole word, with no regex
 * metacharacter — it has the same four matches under every toggle combination,
 * so the expected count holds whatever the user left switched on.
 *
 * WHY THE COUNTER ORACLE IS READ FROM DISK. The counter is a translated string
 * (`editor:findbar.matchCount`, `editor:findbar.noResults`). The journey reads
 * the live UI language from `<html lang>` (src/i18n.ts keeps it in step) and
 * the templates from src/locales/<lang>/editor.json in this Node process, so it
 * asserts the real string under the user's own language instead of failing on
 * correct output in a non-English profile.
 *
 * WAITS — all `poll()`, each on the signal that ends it:
 *  - the counter text: a query change is debounced 150 ms before the editor
 *    rescans (SEARCH_QUERY_CHANGE_DEBOUNCE_MS), then the count is reported on
 *    a microtask;
 *  - the editor text after Replace All: the click dispatches one transaction,
 *    so the DOM is rewritten at once; the poll only absorbs bridge latency;
 *  - "no results" after Replace All: a document change is rescanned 200 ms
 *    later (SEARCH_DOC_CHANGE_DEBOUNCE_MS);
 *  - Source mode: the surface swap is asynchronous, as in journey 03.
 * None of these rides on requestAnimationFrame, so a backgrounded window only
 * slows the timers down; it does not strand the journey.
 *
 * SAFETY. Everything happens in a scratch tab the journey creates and
 * force-discards. The window-level state it touches is put back in `finally`:
 * WYSIWYG mode, the bar's query and replacement text (read from the inputs
 * before typing), whether the bar was open, and the formatting toolbar that
 * opening the bar displaces. No file is written and no dialog is raised.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { evalJs } from "../lib/bridge.mjs";
import {
  withTabRestore,
  createScratchTab,
  setEditorContent,
  getEditorText,
  getEditorMode,
  ensureWysiwygMode,
  emitMenu,
  poll,
} from "../lib/vmark.mjs";

const LOCALES_DIR = fileURLToPath(new URL("../../src/locales/", import.meta.url));

/** src/i18n.ts `fallbackLng`: zh-TW → zh-CN → en; every other language → en. */
const fallbackChain = (lang) => (lang === "zh-TW" ? ["zh-TW", "zh-CN", "en"] : [lang, "en"]);

/** The string the app shows for `ns:key` under `lang`, read from the shipped bundles. */
async function uiString(lang, ns, key) {
  for (const candidate of fallbackChain(lang)) {
    let bundle;
    try {
      bundle = JSON.parse(await readFile(join(LOCALES_DIR, candidate, `${ns}.json`), "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") continue; // not a shipped locale — next in the chain
      throw err;
    }
    if (typeof bundle[key] === "string") return bundle[key];
  }
  throw new Error(`no ${ns}:${key} in any of: ${fallbackChain(lang).join(", ")}`);
}

const interpolate = (template, vars) => template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name]));

const occurrences = (text, needle) => (typeof text === "string" ? text.split(needle).length - 1 : -1);

/** What the bar and the editor show right now. */
function readSearchState(client) {
  return evalJs(
    client,
    `(() => {
       const bar = document.querySelector('.find-bar');
       const inputs = bar ? [...bar.querySelectorAll('.find-bar-input')] : [];
       const replaceAll = bar?.querySelectorAll('.find-bar-replace-actions button')[1] ?? null;
       return {
         open: !!bar,
         query: inputs[0]?.value ?? null,
         replacement: inputs[1]?.value ?? null,
         counter: bar?.querySelector('.find-bar-count')?.textContent ?? null,
         highlighted: document.querySelectorAll('.ProseMirror .search-match').length,
         replaceAllEnabled: replaceAll ? !replaceAll.disabled : null,
         toggles: bar ? [...bar.querySelectorAll('.find-bar-toggle')].map((t) => t.getAttribute('aria-pressed')) : [],
         toolbar: !!document.querySelector('.universal-toolbar'),
       };
     })()`
  );
}

/** Put `value` into the bar's find (0) or replace (1) input the way typing does. */
async function typeIntoBar(client, index, value) {
  const result = await evalJs(
    client,
    `(() => {
       const input = document.querySelectorAll('.find-bar .find-bar-input')[${index}];
       if (!input) return "NO_INPUT";
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(input, ${JSON.stringify(value)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return "OK";
     })()`
  );
  if (result !== "OK") throw new Error(`find bar input ${index} is not mounted (${result})`);
}

const barOpen = (client) => evalJs(client, `!!document.querySelector('.find-bar')`);

export default {
  name: "find-replace",

  async run(client, ctx) {
    const stamp = Date.now().toString(36);
    const needle = `zq${stamp}`;
    const replacement = `rp${stamp}`;
    const TOTAL = 4;
    const markdown = `# ${needle} heading\n\nfirst ${needle} then ${needle}\n\n- item ${needle}\n`;

    const lang = (await evalJs(client, `document.documentElement.lang || "en"`)) || "en";
    const countText = interpolate(await uiString(lang, "editor", "findbar.matchCount"), { current: 1, total: TOTAL });
    const noResultsText = await uiString(lang, "editor", "findbar.noResults");

    await withTabRestore(client, async ({ track }) => {
      const scratch = await createScratchTab(client);
      track(scratch.id);
      const startMode = await getEditorMode(client);
      if (startMode !== "wysiwyg") throw new Error(`expected WYSIWYG start, got ${startMode}`);

      await setEditorContent(client, markdown, { mustBeEmpty: true });
      await poll(
        () => getEditorText(client),
        (t) => occurrences(t, needle) === TOTAL,
        `the scratch document to render all ${TOTAL} occurrences`
      );

      const initial = await readSearchState(client);
      let typed = null; // the bar's own query/replacement before this journey typed, once known
      let journeyError = null;
      try {
        // Open through the menu event. It is a toggle: an already-open bar is
        // closed first, so the opening edge is exercised either way.
        if (initial.open) {
          await emitMenu(client, "find-replace", ctx.windowLabel);
          await poll(() => barOpen(client), (v) => v === false, "the open find bar to close on menu:find-replace");
        }
        await emitMenu(client, "find-replace", ctx.windowLabel);
        const opened = await poll(() => readSearchState(client), (s) => s.open, "find bar to open on menu:find-replace");
        typed = { query: opened.query ?? "", replacement: opened.replacement ?? "" };
        ctx.log(`find bar open (UI language ${lang}; toggles aria-pressed=${JSON.stringify(opened.toggles)})`);

        await typeIntoBar(client, 0, needle);
        const counted = await poll(
          () => readSearchState(client),
          (s) => s.counter === countText && s.highlighted === TOTAL,
          `the counter to read ${JSON.stringify(countText)} with ${TOTAL} highlighted matches`
        );
        ctx.log(`query typed → counter ${JSON.stringify(counted.counter)}, ${counted.highlighted} matches highlighted`);

        await typeIntoBar(client, 1, replacement);
        await poll(
          () => readSearchState(client),
          (s) => s.replacement === replacement && s.replaceAllEnabled === true,
          "the replacement to be in the bar and Replace All to be enabled"
        );
        await evalJs(
          client,
          `(document.querySelectorAll('.find-bar .find-bar-replace-actions button')[1].click(), true)`
        );

        const after = await poll(
          () => getEditorText(client),
          (t) => occurrences(t, replacement) === TOTAL && occurrences(t, needle) === 0,
          `every one of the ${TOTAL} occurrences to be replaced in the editor`
        );
        if (!after.includes(`${replacement} heading`) || !after.includes(`item ${replacement}`)) {
          throw new Error(`replacement landed, but not in every block: ${JSON.stringify(after)}`);
        }
        await poll(
          () => readSearchState(client),
          (s) => s.counter === noResultsText && s.highlighted === 0,
          `the counter to read ${JSON.stringify(noResultsText)} with nothing highlighted`
        );
        ctx.log(`Replace All rewrote ${TOTAL}/${TOTAL} occurrences; the bar reports no match left`);

        // The serialized markdown, not just the rendered text.
        await emitMenu(client, "source-mode", ctx.windowLabel);
        await poll(() => getEditorMode(client), (m) => m === "source", "Source mode (.cm-editor)");
        const source = await poll(
          () => evalJs(client, `document.querySelector('.cm-content')?.textContent ?? ''`),
          (t) => occurrences(t, replacement) === TOTAL && occurrences(t, needle) === 0,
          "the Source view to show the replaced markdown"
        );
        ctx.log(`Source mode shows the replaced markdown (${source.length} chars)`);
      } catch (err) {
        journeyError = err;
      }

      // Put back every piece of window-level state this journey touched. A
      // failed restore is loud when the journey itself passed; otherwise it is
      // logged and the journey's own error stays primary.
      const restoreErrors = [];
      const restore = async (label, fn) => {
        try {
          await fn();
        } catch (err) {
          restoreErrors.push(`${label}: ${err?.message ?? err}`);
        }
      };
      await restore("WYSIWYG mode", () => ensureWysiwygMode(client, ctx.windowLabel));
      await restore("the bar's query and replacement text", async () => {
        if (!typed || !(await barOpen(client))) return;
        await typeIntoBar(client, 0, typed.query);
        await typeIntoBar(client, 1, typed.replacement);
        await poll(
          () => readSearchState(client),
          (s) => s.query === typed.query && s.replacement === typed.replacement,
          "the bar's inputs to hold their original text again"
        );
      });
      await restore("find-bar visibility", async () => {
        const open = await barOpen(client);
        if (open && !initial.open) {
          // The close button, not the menu toggle: it is the path that also
          // gives the status bar its lane back (FindBar.tsx handleClose).
          await evalJs(client, `(document.querySelector('.find-bar .find-bar-close')?.click(), true)`);
        } else if (!open && initial.open) {
          await emitMenu(client, "find-replace", ctx.windowLabel);
        }
        await poll(() => barOpen(client), (v) => v === initial.open, "find bar visibility to be what it was");
      });
      await restore("the formatting toolbar", async () => {
        // Opening the find bar hides it (useSearchCommands); it is a toggle.
        if (!initial.toolbar || (await readSearchState(client)).toolbar) return;
        await emitMenu(client, "universal-toolbar", ctx.windowLabel);
        await poll(() => readSearchState(client), (s) => s.toolbar, "the formatting toolbar to be shown again");
      });

      for (const message of restoreErrors) ctx.log(`restore failed — ${message}`);
      if (journeyError) throw journeyError;
      if (restoreErrors.length > 0) throw new Error(`state not restored: ${restoreErrors.join("; ")}`);
    });
  },
};
