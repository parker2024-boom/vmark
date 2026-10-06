/**
 * Journey: update-checker
 *
 * WHAT IT PROVES. A check for updates started through the app's own request
 * path leaves `checking` and settles in one of the three terminal states the
 * app defines for a check — `up-to-date`, `available`, `error`
 * (services/updates/updateFlows.ts `runUpdateCheck`) — and the main window
 * says so. Whichever of the three it is: the journey never depends on what the
 * update server answers, or on whether it answers at all.
 *
 * THE DEV BUILD DOES NOT DISABLE THE UPDATER. `app_plugins.rs` registers
 * `tauri_plugin_updater` unconditionally (no `debug_assertions` gate), and
 * `tauri.dev.conf.json` overrides only the identifier and icons, so a debug
 * build inherits the release `plugins.updater.endpoints` from `tauri.conf.json`
 * and `check()` makes the real HTTP request. Offline, that is `error`; online,
 * `up-to-date` or `available` depending on the version the checkout is at. All
 * three are asserted, and the log line says which one ran.
 *
 * WHAT IS REAL: the request (`update:request-check`, the event
 * `useUpdateChecker` listens for in the main window — useUpdateOperations.ts
 * `EVENTS.REQUEST_CHECK`; a request arriving this way is a MANUAL check, which
 * is what makes the app answer with a toast), the single-flight
 * `runUpdateCheck`, the updater plugin's `check()` with its 30 s per-request
 * timeout, the store, the persisted check time, and the toasts.
 * WHAT IS NOT: the "Check now" button itself. It lives in the Settings window
 * (pages/settings/AboutSettings.tsx), whose capability
 * (src-tauri/capabilities/settings.json) carries no `mcp-bridge:default`, so a
 * script there cannot return a result on the bridge's IPC path; there is no
 * menu item or command for the check either. Downloading and installing are
 * never reached — see SAFETY.
 *
 * OBSERVATION. `window.__mcpStore` is the store handle `stores/mcpStore.ts`
 * publishes in DEV builds. A recorder subscribes to it and keeps every status
 * transition with a timestamp, and a MutationObserver keeps every sonner toast
 * (`[data-sonner-toast][data-type]`) it sees — a check can finish inside one
 * poll interval, and its toast lives 3 s, so sampling alone could miss both.
 * The surface asserted per state (all in the main window):
 *   up-to-date → a `success` toast with the exact `dialog:toast.updateUpToDate`
 *                string of the live UI language (`<html lang>`, src/i18n.ts);
 *                `update.lastCheckTimestamp` persisted at or after the request;
 *   available  → the status bar's `info` toast naming `v<version>`
 *                (statusbar:updateAvailableVersion — every locale keeps the
 *                literal `v{{version}}`); the check time persisted likewise;
 *   error      → an `error` toast carrying the store's own error message
 *                (dialog:toast.updateCheckFailed interpolates `{{error}}` in
 *                every locale); the persisted check time left untouched.
 *
 * WAITS — all `poll()`:
 *  - start (8 s): the event reaches the listener over Tauri IPC and
 *    `runUpdateCheck` sets `checking` synchronously, so this only absorbs
 *    bridge latency; the recorder catches a `checking` that has already ended.
 *    A check already in flight (the startup auto-check) counts: the request
 *    joins it through the single-flight guard and marks it manual;
 *  - settle (62 s): the plugin tries two endpoints with a 30 s timeout each
 *    (`UPDATE_CHECK_TIMEOUT_MS`), and the app's own stall detector calls
 *    `checking` stuck at 60 s (`CHECK_STALL_MS`, hooks/useUpdateStall.ts). Still
 *    `checking` past that is the defect this journey exists to catch. The
 *    state must be the same on two consecutive samples, so a check that ends
 *    just as the request lands (and is followed by the requested one) is not
 *    mistaken for the answer;
 *  - toast (5 s): raised by a React effect on the transition; the recorder has
 *    it even if it has already timed out of the DOM.
 * Worst case 75 s, inside the runner's 90 s journey cap.
 *
 * SAFETY. A found update is downloaded and installed automatically when
 * `update.autoDownload` is on (useUpdateChecker), so the journey SKIPS in that
 * profile rather than flip the setting: restoring it to "on" while an update is
 * `available` would start the download. It also skips while a transfer is in
 * progress or finished (`downloading` / `installing` / `ready`) — a new check
 * would discard that state, which is why the app disables its own button then.
 * Neither skip is lost coverage (both are valid user state), so the journey is
 * not `coverageRequired`. No tab is touched and no dialog is raised. The one
 * setting the check itself writes, `update.lastCheckTimestamp`, is put back in
 * `finally` — absent stays absent — so the run does not postpone the user's
 * next scheduled check.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalJs } from "../lib/bridge.mjs";
import { emitEvent, poll, readLocalStorage, restoreLocalStorage } from "../lib/vmark.mjs";
import { readPersistedSettingsSection } from "../lib/settingsPatch.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SETTINGS_KEY = "vmark-settings";
const DEFAULTS_PATH = "src/stores/settingsStore/defaults.ts";

const TERMINAL = ["up-to-date", "available", "error"];
const TRANSFER = ["downloading", "installing", "ready"];

const START_TIMEOUT_MS = 8000;
const SETTLE_TIMEOUT_MS = 62000;
const TOAST_TIMEOUT_MS = 5000;

/**
 * The shipped `update.autoDownload`, read from the app's own defaults — the
 * live value whenever the persisted blob does not carry the key. Throws rather
 * than assume: a wrong guess here is the difference between observing an
 * update and installing one.
 */
function shippedAutoDownloadDefault() {
  const src = readFileSync(join(REPO, DEFAULTS_PATH), "utf8");
  const m = /^\s*autoDownload:\s*(true|false)\s*,/m.exec(src);
  if (!m) throw new Error(`${DEFAULTS_PATH} no longer declares a boolean \`autoDownload\` default`);
  return m[1] === "true";
}

/** One translated string of the live UI language, read from the repository. */
function localized(lang, namespace, key) {
  if (typeof lang !== "string" || !/^[A-Za-z]+(-[A-Za-z]+)*$/.test(lang)) {
    throw new Error(`<html lang> is not a locale id: ${JSON.stringify(lang)}`);
  }
  const path = join("src", "locales", lang, `${namespace}.json`);
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(join(REPO, path), "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${path} for the app's UI language: ${err?.message ?? err}`);
  }
  const text = bundle[key];
  if (typeof text !== "string" || text === "") throw new Error(`${path} has no "${key}"`);
  return text;
}

/**
 * Install the recorder. Returns the status at install time, or "NO_STORE"
 * when the DEV store handle is absent. Toasts already on screen are recorded
 * with the install time, which is before any transition this journey causes.
 */
function installRecorder(client, slot) {
  return evalJs(
    client,
    `(() => {
       const store = window.__mcpStore;
       if (!store || typeof store.getState !== "function" || typeof store.subscribe !== "function") return "NO_STORE";
       const rec = { history: [], toasts: [] };
       const lastText = new WeakMap();
       const scan = () => {
         for (const el of document.querySelectorAll("[data-sonner-toast]")) {
           const text = el.textContent || "";
           if (lastText.get(el) === text) continue;
           lastText.set(el, text);
           rec.toasts.push({ type: el.getAttribute("data-type"), text, at: Date.now() });
         }
       };
       scan();
       let last = store.getState().update.status;
       rec.unsubscribe = store.subscribe((state) => {
         const status = state.update.status;
         if (status === last) return;
         last = status;
         rec.history.push({ status, at: Date.now() });
       });
       rec.observer = new MutationObserver(scan);
       rec.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-type"] });
       window[${JSON.stringify(slot)}] = rec;
       return last;
     })()`
  );
}

/** The store's update slice, the recorder's log, and the toasts on screen now. */
function snapshot(client, slot) {
  return evalJs(
    client,
    `(() => {
       const store = window.__mcpStore;
       const rec = window[${JSON.stringify(slot)}];
       if (!store || !rec) return null;
       const u = store.getState().update;
       return {
         status: u.status,
         error: u.error,
         version: u.updateInfo ? u.updateInfo.version : null,
         hasPending: u.pendingUpdate !== null,
         history: rec.history.slice(),
         toasts: rec.toasts.slice(),
         visible: [...document.querySelectorAll("[data-sonner-toast]")].map((el) => ({
           type: el.getAttribute("data-type"),
           text: el.textContent || "",
         })),
         lang: document.documentElement.lang || null,
       };
     })()`
  );
}

function removeRecorder(client, slot) {
  return evalJs(
    client,
    `(() => {
       const rec = window[${JSON.stringify(slot)}];
       if (!rec) return true;
       try { rec.unsubscribe(); } catch (e) { /* the store is gone with the page */ }
       try { rec.observer.disconnect(); } catch (e) { /* likewise */ }
       delete window[${JSON.stringify(slot)}];
       return true;
     })()`
  );
}

/**
 * Put the persisted `update.lastCheckTimestamp` back exactly as it was and let
 * the running store adopt it through its own storage-event path
 * (hooks/useSettingsSync.ts). Presence-faithful at every level: no blob before
 * → the key is removed; no `update` section before → the section is removed;
 * no leaf before → the leaf is removed. A `null` or absent prior value cannot
 * reset the LIVE store (its reconciler never applies null), so this session
 * keeps the newer time — which only makes it less eager to check again.
 */
async function restoreLastCheck(client, rawBefore, sectionBefore) {
  if (rawBefore === null) {
    await restoreLocalStorage(client, SETTINGS_KEY, null);
    return;
  }
  const hadLeaf = sectionBefore !== null && Object.prototype.hasOwnProperty.call(sectionBefore, "lastCheckTimestamp");
  const ok = await evalJs(
    client,
    `(() => {
       try {
         const key = ${JSON.stringify(SETTINGS_KEY)};
         const oldValue = localStorage.getItem(key);
         const parsed = JSON.parse(oldValue || "{}");
         parsed.state = parsed.state || {};
         if (${JSON.stringify(sectionBefore === null)}) {
           delete parsed.state.update;
         } else {
           parsed.state.update = parsed.state.update || {};
           if (${JSON.stringify(hadLeaf)}) parsed.state.update.lastCheckTimestamp = ${JSON.stringify(hadLeaf ? sectionBefore.lastCheckTimestamp : null)};
           else delete parsed.state.update.lastCheckTimestamp;
         }
         const newValue = JSON.stringify(parsed);
         if (newValue === oldValue) return true;
         localStorage.setItem(key, newValue);
         window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue, storageArea: localStorage }));
         return true;
       } catch (e) { return "ERR " + (e && e.message); }
     })()`
  );
  if (ok !== true) throw new Error(`could not restore update.lastCheckTimestamp: ${ok}`);
}

/** The toast the app must show for a settled check: its type and a string it contains. */
function expectedToast(state) {
  if (state.status === "up-to-date") {
    return { type: "success", needle: localized(state.lang, "dialog", "toast.updateUpToDate") };
  }
  if (state.status === "available") return { type: "info", needle: `v${state.version}` };
  return { type: "error", needle: state.error };
}

export default {
  name: "update-checker",

  async run(client, ctx) {
    const sectionBefore = await readPersistedSettingsSection(client, "update");
    const autoDownload =
      typeof sectionBefore?.autoDownload === "boolean" ? sectionBefore.autoDownload : shippedAutoDownloadDefault();
    if (autoDownload) {
      return {
        skip: "update.autoDownload is on — a found update would be downloaded and installed, which this journey must never cause",
      };
    }
    const rawBefore = await readLocalStorage(client, SETTINGS_KEY);
    const slot = `__vmarkE2eUpdateCheck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let bodyFailed = false;
    try {
      const initial = await installRecorder(client, slot);
      if (initial === "NO_STORE") {
        throw new Error("window.__mcpStore is absent — the app is not a DEV build, so the update state cannot be observed");
      }
      if (TRANSFER.includes(initial)) {
        return { skip: `an update transfer is "${initial}" — a new check would discard it (the app disables its own button)` };
      }
      ctx.log(`update status before the request: ${initial}${initial === "checking" ? " (a check is already in flight; joining it)" : ""}`);

      const requestedAt = await evalJs(client, `Date.now()`);
      await emitEvent(client, "update:request-check", null);

      // ---- the check starts ----
      await poll(
        () => snapshot(client, slot),
        (s) => s !== null && (s.status === "checking" || s.history.some((h) => h.status === "checking" && h.at >= requestedAt)),
        "the check to start (update:request-check → useUpdateChecker → status \"checking\")",
        { timeoutMs: START_TIMEOUT_MS }
      );

      // ---- and it does not stick ----
      let previous = null;
      const settled = await poll(
        () => snapshot(client, slot),
        (s) => {
          const stable = s !== null && s.status !== "checking" && s.status === previous;
          previous = s === null ? null : s.status;
          return stable;
        },
        "the check to leave \"checking\" and stay settled (two endpoints × 30 s; the app itself calls 60 s a stall)",
        { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 250 }
      );
      if (!TERMINAL.includes(settled.status)) {
        throw new Error(
          `the check settled in "${settled.status}", which is not a terminal state of a check ` +
            `(${TERMINAL.join(" / ")}); transitions: ${JSON.stringify(settled.history)}`
        );
      }
      const settledAt = settled.history.length ? settled.history[settled.history.length - 1].at : requestedAt;

      // ---- the store is consistent with the state it names ----
      if (settled.status === "error" && (typeof settled.error !== "string" || settled.error === "")) {
        throw new Error("status is \"error\" but the store carries no error message for the UI to show");
      }
      if (settled.status !== "error" && settled.error !== null) {
        throw new Error(`status is "${settled.status}" but a stale error is still set: ${settled.error}`);
      }
      if (settled.status === "available" && (typeof settled.version !== "string" || settled.version === "")) {
        throw new Error("status is \"available\" but no version is recorded for the UI to show");
      }
      if (settled.status === "up-to-date" && settled.hasPending) {
        throw new Error("status is \"up-to-date\" but a pending update handle is still held");
      }

      // ---- the persisted check time follows the outcome ----
      const sectionAfter = await readPersistedSettingsSection(client, "update");
      const stampAfter = sectionAfter?.lastCheckTimestamp ?? null;
      const stampBefore = sectionBefore?.lastCheckTimestamp ?? null;
      if (settled.status === "error") {
        if (stampAfter !== stampBefore) {
          throw new Error(`a FAILED check stamped update.lastCheckTimestamp (${stampBefore} → ${stampAfter})`);
        }
      } else if (typeof stampAfter !== "number" || stampAfter < requestedAt) {
        throw new Error(
          `a completed check did not persist update.lastCheckTimestamp at or after the request ` +
            `(persisted ${stampAfter}, requested at ${requestedAt})`
        );
      }

      // ---- the main window says so ----
      const want = expectedToast(settled);
      const matches = (t) => t.type === want.type && typeof t.text === "string" && t.text.includes(want.needle);
      await poll(
        () => snapshot(client, slot),
        (s) => s !== null && (s.visible.some(matches) || s.toasts.some((t) => matches(t) && t.at >= settledAt)),
        `a "${want.type}" toast containing ${JSON.stringify(want.needle)} for the "${settled.status}" state`,
        { timeoutMs: TOAST_TIMEOUT_MS }
      );

      ctx.log(
        `branch=${settled.status}` +
          (settled.status === "available" ? ` (v${settled.version})` : "") +
          (settled.status === "error" ? ` (${settled.error.slice(0, 120)})` : "") +
          ` — ${want.type} toast shown; transitions ${JSON.stringify(settled.history.map((h) => h.status))}`
      );
    } catch (err) {
      bodyFailed = true;
      throw err;
    } finally {
      await removeRecorder(client, slot).catch(() => {});
      // A restore failure is loud — a journey that leaves the profile changed
      // has reconfigured the user — unless the body already failed, in which
      // case the body's error stays primary and this one is logged.
      try {
        await restoreLastCheck(client, rawBefore, sectionBefore);
        const restored = await readPersistedSettingsSection(client, "update");
        const before = sectionBefore?.lastCheckTimestamp ?? null;
        const after = restored?.lastCheckTimestamp ?? null;
        if (after !== before) {
          throw new Error(`update.lastCheckTimestamp was not restored (${before} before, ${after} now)`);
        }
      } catch (err) {
        if (!bodyFailed) throw err;
        ctx.log(`warning: ${err?.message ?? err}`);
      }
    }
  },
};
