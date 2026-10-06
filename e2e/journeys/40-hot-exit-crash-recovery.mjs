/**
 * Journey: hot-exit-crash-recovery  (Tier-0 · data integrity)
 *
 * Unsaved work has two safety nets, and both end in a file only the real app
 * writes — which is why no jsdom test can vouch for them:
 *
 *   1. CRASH RECOVERY. Every 10 s each window writes a snapshot of every dirty
 *      document to `<appDataDir>/recovery/snapshot-<tabId>.json`
 *      (hooks/resilience/_crashRecoveryWriter.ts → services/persistence/
 *      crashRecovery.ts). After a hard crash that file is the ONLY record of
 *      the edit. This journey edits a file-backed document without saving,
 *      waits for the real interval, and reads the snapshot FROM DISK in Node:
 *      the unsaved text, the file path, the tab. Then it saves, and the
 *      snapshot must be gone — a snapshot that outlives its save reopens a
 *      ghost dirty tab on the next launch.
 *
 *   2. HOT EXIT. Before a coordinated restart Rust asks every window for its
 *      state and persists the session (`hot_exit_capture`). The journey invokes
 *      that command exactly as `restartWithHotExit` does, then reads the session
 *      back through `hot_exit_inspect_session` — the command the next launch
 *      reads it with — and asserts the unsaved document is in it, dirty, with
 *      its text and its saved baseline. The capture round-trips through the
 *      real IPC, the real Rust merge and the real atomic write.
 *
 * WHAT STAYS OUT, and where it is covered instead. The RESTORE half replaces a
 * window's tabs, and a real restore needs the process to die and come back;
 * neither can be done to a live app that may hold a maintainer's documents
 * (safety model rule 1), and the harness cannot restart the app. The whole
 * capture → crash → restore composition, including dirty flags and line
 * endings after restore, runs on every PR in
 * `src/test/tier0/hotExitRecovery.test.tsx`.
 *
 * SAFETY. Autosave is switched off for the journey through the app's own
 * settings-sync path and restored exactly (an absent key stays absent): an
 * autosave inside the snapshot interval would make the document clean, and a
 * clean document has no snapshot. The session file is written only when none existed beforehand (a
 * file that is already there is evidence from a previous run the app chose to
 * keep, and is not ours to overwrite or clear), and is cleared in `finally`.
 * The document is a fixture in a throwaway `$HOME` dir; the tab is saved clean
 * before teardown, so nothing is discarded.
 *
 * WAITS. The snapshot poll is bounded by the writer's 10 s interval, so its
 * timeout is two intervals plus slack rather than the suite default. Nothing
 * here sleeps.
 */

import { writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { makeAppTempDir } from "../lib/fixtures.mjs";
import { openFixtureInNewTab } from "../lib/disk.mjs";
import { evalJs } from "../lib/bridge.mjs";
import { patchPersistedSettings, readPersistedSettingsSection } from "../lib/settingsPatch.mjs";
import {
  withTabRestore,
  createScratchTab,
  appendToActiveEditor,
  emitMenu,
  getTabs,
  getEditorText,
  getPersistedWorkspaceRoot,
  readLocalStorage,
  restoreLocalStorage,
  poll,
} from "../lib/vmark.mjs";

/** Two writer intervals (10 s each) plus slack. */
const SNAPSHOT_TIMEOUT_MS = 25_000;

/** Invoke a Rust command from the page and return its JSON-safe result. */
async function invoke(client, command, args = {}) {
  const raw = await evalJs(
    client,
    `(async () => {
       try {
         const v = await window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
         return JSON.stringify({ ok: true, value: v ?? null });
       } catch (e) {
         return JSON.stringify({ ok: false, error: (e && (e.message || JSON.stringify(e))) || String(e) });
       }
     })()`,
    30_000,
  );
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(`${command} failed: ${parsed.error}`);
  return parsed.value;
}

/** Read the recovery snapshot for `tabId` from disk, or null when there is none. */
async function readSnapshot(recoveryDir, tabId) {
  let names;
  try {
    names = await readdir(recoveryDir);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const name = `snapshot-${tabId}.json`;
  if (!names.includes(name)) return null;
  try {
    return JSON.parse(await readFile(join(recoveryDir, name), "utf8"));
  } catch {
    return null; // mid-rename; the next poll reads the finished file
  }
}

export default {
  name: "hot-exit-crash-recovery",
  coverageRequired: true,

  async run(client, ctx) {
    const root = await getPersistedWorkspaceRoot(client, ctx.windowLabel);
    if (root) {
      return { skip: `workspace open (${root}) — Finder-open of an outside file would spawn a new window` };
    }

    // An async function, not a bare promise: the bridge serializes what the
    // script evaluates to, and a promise that is not awaited arrives as `{}`.
    const appDataDir = await evalJs(client, `(async () => await window.__TAURI__.path.appDataDir())()`);
    if (typeof appDataDir !== "string" || appDataDir.length === 0) {
      throw new Error(`appDataDir() did not resolve to a path (got ${JSON.stringify(appDataDir)})`);
    }
    const recoveryDir = join(appDataDir, "recovery");

    const sessionBefore = await invoke(client, "hot_exit_inspect_session");
    const mayCapture = sessionBefore === null;
    if (!mayCapture) {
      ctx.log("a hot-exit session file already exists — it is left untouched and the capture half is not run");
    }

    // Autosave would turn the unsaved edit into a saved one mid-journey (a clean
    // document has no snapshot), so it is off for the duration and put back
    // exactly as it was — including "absent", which must stay absent.
    const general = (await readPersistedSettingsSection(client, "general")) ?? {};
    const hadAutoSaveKey = Object.hasOwn(general, "autoSaveEnabled");
    const autoSaveBefore = general.autoSaveEnabled;

    const fixture = await makeAppTempDir();
    let captured = false;
    let clearFailure = null;
    try {
      await patchPersistedSettings(client, "general", { autoSaveEnabled: false });
      const filePath = join(fixture.dir, `journey-recovery-${fixture.stamp}.md`);
      const original = `# Recovery Journey\n\nsaved body ${fixture.stamp}\n`;
      const marker = `unsaved-${fixture.stamp}`;
      await writeFile(filePath, original, "utf8");

      const recentsBefore = await readLocalStorage(client, "vmark-recent-files");
      try {
        await withTabRestore(client, async ({ before, track }) => {
          const guard = await createScratchTab(client);
          track(guard.id);
          const fileTab = await openFixtureInNewTab(client, { before, track, guardId: guard.id, filePath });
          await poll(
            () => getEditorText(client),
            (t) => typeof t === "string" && t.includes(`saved body ${fixture.stamp}`),
            "fixture content loaded into the editor",
          );

          await appendToActiveEditor(client, " " + marker);
          await poll(
            () => getTabs(client),
            (ts) => ts.find((t) => t.id === fileTab.id)?.dirty === true,
            "edit to mark the fixture tab dirty",
          );
          // The edit must not have reached the file: what follows is about UNSAVED work.
          if ((await readFile(filePath, "utf8")) !== original) {
            throw new Error("the fixture changed on disk before any save, with autosave switched off for this journey");
          }

          // ── 1. crash recovery: the snapshot on disk carries the unsaved text ──
          const snapshot = await poll(
            () => readSnapshot(recoveryDir, fileTab.id),
            (s) => s !== null && typeof s.content === "string" && s.content.includes(marker),
            `recovery snapshot for the dirty tab in ${recoveryDir}`,
            { timeoutMs: SNAPSHOT_TIMEOUT_MS, intervalMs: 500 },
          );
          if (snapshot.filePath !== filePath) {
            throw new Error(`snapshot names ${JSON.stringify(snapshot.filePath)}, expected ${JSON.stringify(filePath)}`);
          }
          if (snapshot.tabId !== fileTab.id || snapshot.windowLabel !== ctx.windowLabel) {
            throw new Error(`snapshot is for tab ${snapshot.tabId} in ${snapshot.windowLabel}, expected ${fileTab.id} in ${ctx.windowLabel}`);
          }
          if (!snapshot.content.includes(`saved body ${fixture.stamp}`)) {
            throw new Error(`snapshot lost the document's saved text: ${JSON.stringify(snapshot.content)}`);
          }
          ctx.log(`recovery snapshot on disk carries the unsaved edit (${snapshot.content.length} chars)`);

          // ── 2. hot exit: the captured session carries the dirty document ──
          if (mayCapture) {
            await invoke(client, "hot_exit_capture");
            captured = true;
            const session = await invoke(client, "hot_exit_inspect_session");
            if (!session || !Array.isArray(session.windows)) {
              throw new Error(`hot_exit_inspect_session returned no session after a capture: ${JSON.stringify(session)?.slice(0, 200)}`);
            }
            const win = session.windows.find((w) => w.window_label === ctx.windowLabel);
            const tab = win?.tabs?.find((t) => t.file_path === filePath);
            if (!tab) {
              throw new Error(`captured session has no tab for the fixture (window tabs: ${JSON.stringify(win?.tabs?.map((t) => t.file_path))})`);
            }
            if (tab.document.is_dirty !== true) throw new Error("captured document is not marked dirty");
            if (!tab.document.content.includes(marker)) {
              throw new Error(`captured content lacks the unsaved edit: ${JSON.stringify(tab.document.content)}`);
            }
            if (tab.document.saved_content !== original) {
              throw new Error(`captured saved baseline is not the file's content: ${JSON.stringify(tab.document.saved_content)}`);
            }
            ctx.log(`captured session holds the fixture tab dirty, with its edit and its saved baseline`);
          }

          // ── 3. saving ends the need for recovery: the snapshot is removed ──
          await emitMenu(client, "save", ctx.windowLabel);
          await poll(
            () => getTabs(client),
            (ts) => ts.find((t) => t.id === fileTab.id)?.dirty === false,
            "save to clear dirty on the fixture tab",
          );
          await poll(
            () => readSnapshot(recoveryDir, fileTab.id),
            (s) => s === null,
            "recovery snapshot to be deleted after the save",
          );
          const onDisk = await readFile(filePath, "utf8");
          if (!onDisk.includes(marker)) {
            throw new Error(`the save did not write the edit: ${JSON.stringify(onDisk)}`);
          }
        });
      } finally {
        try {
          await restoreLocalStorage(client, "vmark-recent-files", recentsBefore);
        } catch (err) {
          ctx.log(`warning: could not restore recent-files (${err?.message ?? err})`);
        }
      }
    } finally {
      // Ours to remove: it did not exist before, and it names a fixture that is about to be deleted.
      if (captured) {
        try {
          await invoke(client, "hot_exit_clear_session");
        } catch (err) {
          // Loud: a session left behind would restore a deleted fixture on the next launch.
          clearFailure = new Error(
            `the captured hot-exit session could not be cleared — clear it by hand before relaunching (${err?.message ?? err})`,
          );
          ctx.log(`ERROR: ${clearFailure.message}`);
        }
      }
      try {
        if (hadAutoSaveKey) {
          await patchPersistedSettings(client, "general", { autoSaveEnabled: autoSaveBefore });
        } else {
          await patchPersistedSettings(client, "general", {}, { deleteKeys: ["autoSaveEnabled"] });
        }
      } finally {
        await fixture.cleanup();
      }
    }
    if (clearFailure) throw clearFailure;
  },
};
