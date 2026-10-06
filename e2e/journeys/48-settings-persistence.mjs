/**
 * Journey: settings-persistence
 *
 * WHAT IT PROVES, in the live app: a setting changed through a real UI path is
 * (1) painted in the main window, (2) written to WebKit's own
 * `localStorage["vmark-settings"]` BEFORE it is painted, and (3) re-adopted by
 * the running store when that blob is changed underneath it — the way another
 * window's write arrives — without a reload.
 *
 * THE SETTING is the editor font size, `appearance.fontSize`. It is harmless,
 * it is visibly rendered (`useTheme` writes `--editor-font-size: <n>px` on
 * `<html>`, hooks/useTheme.ts `computeTypographyVars`), and it has a real UI
 * path inside the main window: View → Zoom In / Zoom Out
 * (src-tauri/src/menu/localized/view_menu.rs `zoom-in` / `zoom-out` →
 * `menu:zoom-in` → `view.zoomIn`, hooks/useCommandBootstrap.ts →
 * services/commands/viewZoomCommands.ts →
 * `updateAppearanceSetting("fontSize", …)`). That is the same store action the
 * Settings window's Editor → Font size row calls (pages/settings/EditorSettings.tsx).
 *
 * WHY NOT THE SETTINGS WINDOW. It is a separate webview (`settings`), and its
 * capability (src-tauri/capabilities/settings.json) has no `mcp-bridge:default`.
 * The bridge returns a script's result through
 * `plugin:mcp-bridge|script_result`, which that window may not invoke, so on
 * Linux nothing run there can answer, and on macOS only a script with no
 * promise in it can (the bridge then evaluates natively). Opening and closing a
 * window the user may already have open, to click a control this way, is a
 * worse proof than the menu command — and no dev-module store import is needed
 * either, because the menu reaches the store by itself.
 *
 * WHAT A RESTART WOULD PROVE, AND WHO PROVES IT. A true process restart is
 * outside this harness (the bridge dies with the process, and the suite must
 * leave the user's session running). What survives a restart is exactly the
 * blob, so the journey asserts the blob (a fresh read, not the store's echo),
 * and the reading half — a new store instance hydrating from that blob through
 * migrate + merge + sanitize + clamp — is the jsdom flow's
 * (src/test/tier0/settingsPersistence.test.ts, a fresh module graph per
 * "launch"). The reload-free equivalent here is step (3): the blob is changed
 * to a third value and a `storage` event is dispatched — the app's own
 * cross-window path (hooks/useSettingsSync.ts → `reconcileSettings`), the same
 * guards hydration runs — and the paint must follow the blob.
 *
 * ORACLES. The step the app will take is computed from the same rule the
 * command uses (`zoomStep`: 2 px, stopping at 12 / 32, never reversing), from
 * the LIVE size, so the journey holds at any starting size: at or above the
 * upper bound it zooms out instead. The persisted value is compared as a
 * number; the paint as the exact `"<n>px"` string.
 *
 * WAITS — all `poll()`: the store update and the localStorage write are
 * synchronous inside the command; the CSS variable is written by a React
 * effect on the next render. So each poll waits on the paint and only absorbs
 * render + bridge latency (no requestAnimationFrame is involved, so a
 * backgrounded window still settles), and the blob is then read ONCE, without
 * polling — by the time the paint is visible the write must already be there.
 *
 * SAFETY. No tab is touched, no dialog is raised, no window is opened. The font
 * size is put back in `finally` through the storage-event path, the paint is
 * asserted to have reverted, and the persisted `appearance` section is then
 * restored to its exact prior form — a profile that had no blob, no section or
 * no `fontSize` key before has none after — so a later change of the shipped
 * default is not shadowed by a value this run wrote.
 */

import { evalJs } from "../lib/bridge.mjs";
import { emitMenu, poll, readLocalStorage, restoreLocalStorage } from "../lib/vmark.mjs";
import { patchPersistedSettings, readPersistedSettingsSection } from "../lib/settingsPatch.mjs";

const SETTINGS_KEY = "vmark-settings";
const CSS_VAR = "--editor-font-size";

/** services/commands/viewZoomCommands.ts: FONT_SIZE_STEP, MIN_FONT_SIZE, MAX_FONT_SIZE. */
const ZOOM = { step: 2, min: 12, max: 32 };
/** stores/settingsStore/clamp.ts: CLAMP_RANGES.appearance.fontSize. */
const STORE_RANGE = { min: 8, max: 48 };

/** Mirror of `zoomStep` (viewZoomCommands.ts): stops at the bound, never reverses. */
function zoomStep(current, step, bound) {
  const stepped = step > 0 ? Math.min(current + step, bound) : Math.max(current + step, bound);
  return step > 0 ? Math.max(current, stepped) : Math.min(current, stepped);
}

const clampToStore = (size) => Math.min(Math.max(size, STORE_RANGE.min), STORE_RANGE.max);

/** The painted editor font size, e.g. "18px" (the value `useTheme` wrote on <html>). */
function readPaintedFontSize(client) {
  return evalJs(
    client,
    `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(CSS_VAR)}).trim()`
  );
}

function waitForPaint(client, size, label) {
  return poll(() => readPaintedFontSize(client), (v) => v === `${size}px`, label);
}

/** The persisted `appearance.fontSize`, from a fresh read of the blob (undefined when absent). */
async function readPersistedFontSize(client) {
  const appearance = await readPersistedSettingsSection(client, "appearance");
  return appearance?.fontSize;
}

/** Put the persisted `appearance` section back verbatim (absent stays absent). No event: the live store is already there. */
async function restoreAppearanceSection(client, rawBefore, appearanceBefore) {
  if (rawBefore === null) {
    await restoreLocalStorage(client, SETTINGS_KEY, null);
    return;
  }
  const ok = await evalJs(
    client,
    `(() => {
       try {
         const key = ${JSON.stringify(SETTINGS_KEY)};
         const parsed = JSON.parse(localStorage.getItem(key) || "{}");
         parsed.state = parsed.state || {};
         const before = ${JSON.stringify(appearanceBefore)};
         if (before === null) delete parsed.state.appearance;
         else parsed.state.appearance = before;
         localStorage.setItem(key, JSON.stringify(parsed));
         return true;
       } catch (e) { return "ERR " + (e && e.message); }
     })()`
  );
  if (ok !== true) throw new Error(`could not restore the persisted appearance section: ${ok}`);
}

export default {
  name: "settings-persistence",

  async run(client, ctx) {
    const paintedBefore = await readPaintedFontSize(client);
    if (!/^\d+(\.\d+)?px$/.test(paintedBefore)) {
      throw new Error(`${CSS_VAR} on <html> is not a pixel size: ${JSON.stringify(paintedBefore)} — useTheme has not applied typography`);
    }
    const original = parseFloat(paintedBefore);
    const rawBefore = await readLocalStorage(client, SETTINGS_KEY);
    const appearanceBefore = await readPersistedSettingsSection(client, "appearance");

    // What is on disk is what is shown — the precondition of everything below.
    const persistedBefore = appearanceBefore?.fontSize;
    if (typeof persistedBefore === "number" && Number.isFinite(persistedBefore) && clampToStore(persistedBefore) !== original) {
      throw new Error(
        `the main window paints ${paintedBefore} but the persisted appearance.fontSize is ${persistedBefore} — ` +
          "the running store has diverged from localStorage before this journey changed anything"
      );
    }

    const zoomedIn = zoomStep(original, ZOOM.step, ZOOM.max);
    const menuId = zoomedIn !== original ? "zoom-in" : "zoom-out";
    const changed = zoomedIn !== original ? zoomedIn : zoomStep(original, -ZOOM.step, ZOOM.min);
    if (changed === original) throw new Error(`no zoom step is available from ${paintedBefore}`);
    // A third value, distinct from both, for the storage-event leg.
    const fromOutside = changed + 1 <= STORE_RANGE.max ? changed + 1 : changed - 1;
    ctx.log(`font size ${paintedBefore}; View → ${menuId} must give ${changed}px, then a foreign write ${fromOutside}px`);

    let bodyFailed = false;
    try {
      // ---- (1) the real UI path paints ----
      await emitMenu(client, menuId, ctx.windowLabel);
      await waitForPaint(client, changed, `menu:${menuId} to repaint ${CSS_VAR} as ${changed}px`);

      // ---- (2) and it is already in the blob ----
      const raw = await readLocalStorage(client, SETTINGS_KEY);
      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch {
        throw new Error(`localStorage["${SETTINGS_KEY}"] is not JSON after the change: ${String(raw).slice(0, 120)}`);
      }
      if (typeof envelope?.version !== "number" || envelope.state?.appearance?.fontSize !== changed) {
        throw new Error(
          `the painted size ${changed}px is not in the persisted blob: version=${JSON.stringify(envelope?.version)}, ` +
            `appearance.fontSize=${JSON.stringify(envelope?.state?.appearance?.fontSize)}`
        );
      }
      ctx.log(`painted ${changed}px and persisted appearance.fontSize=${changed} (envelope version ${envelope.version})`);

      // ---- (3) the running store follows the blob (the cross-window path) ----
      await patchPersistedSettings(client, "appearance", { fontSize: fromOutside });
      await waitForPaint(client, fromOutside, `a storage event carrying fontSize ${fromOutside} to repaint ${CSS_VAR}`);
      const afterForeignWrite = await readPersistedFontSize(client);
      if (afterForeignWrite !== fromOutside) {
        throw new Error(
          `after adopting the foreign value the blob holds ${JSON.stringify(afterForeignWrite)}, not ${fromOutside} — ` +
            "this window wrote its own snapshot back over the other writer"
        );
      }
      ctx.log(`storage event adopted without a reload: painted ${fromOutside}px, blob still ${fromOutside}`);
    } catch (err) {
      bodyFailed = true;
      throw err;
    } finally {
      // Restore is loud unless the body already failed (then the body's error
      // stays primary): a journey that leaves the font size changed has
      // reconfigured the user's editor.
      try {
        await patchPersistedSettings(client, "appearance", { fontSize: original });
        await waitForPaint(client, original, `the font size to revert to ${paintedBefore}`);
        await restoreAppearanceSection(client, rawBefore, appearanceBefore);
        const restored = await readPersistedSettingsSection(client, "appearance");
        if (JSON.stringify(restored) !== JSON.stringify(appearanceBefore)) {
          throw new Error(
            `the persisted appearance section was not restored: ${JSON.stringify(appearanceBefore)} before, ${JSON.stringify(restored)} now`
          );
        }
      } catch (err) {
        if (!bodyFailed) throw err;
        ctx.log(`warning: restore failed (${err?.message ?? err})`);
      }
    }
    ctx.log(`font size back to ${paintedBefore}; persisted appearance section identical to before`);
  },
};
