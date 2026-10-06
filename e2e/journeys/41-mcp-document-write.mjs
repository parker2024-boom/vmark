/**
 * Journey: mcp-document-write  (Tier-0 · data integrity)
 *
 * An AI client's `document.write` replaces a document AND saves it. If that
 * write goes around the app's save pipeline, the file loses its line endings
 * and its BOM, the tab stays dirty over bytes that are already on disk, and the
 * revision the client was handed is stale before it can use it — each of which
 * shipped once, with every handler-level test green.
 *
 * So this journey takes the path an AI client takes, end to end: the REAL MCP
 * sidecar over stdio (`e2e/lib/vmarkMcp.mjs` — initialize, tool discovery, the
 * sidecar's argument validation and error transformation), VMark's own
 * authenticated bridge, the live handler, the live editor, the real save
 * pipeline; and then reads the file FROM DISK in this Node process.
 *
 * What it asserts, on a CRLF file that starts with a BOM:
 *   - `read` hands back LF text with no BOM, and a revision;
 *   - `write` with that revision reports `saved: true` and a new revision;
 *   - the bytes on disk are the client's text in the file's own convention —
 *     whole-buffer comparison, BOM included (the EOL is derived from the live
 *     `lineEndingsOnSave` preference, as in `line-ending-preservation`);
 *   - the tab is clean and the editor shows the new text;
 *   - a second `read` returns the revision the write returned, not dirty;
 *   - a write carrying the FIRST revision is refused as STALE, names the
 *     current revision in `structuredContent`, and changes nothing on disk.
 *
 * The same flow runs on every PR against the in-memory disk in
 * `src/test/tier0/mcpDocumentWrite.test.tsx`; this is the only place the real
 * sidecar, the real IPC and a real filesystem are in the loop.
 *
 * Safety: identical to the other disk journeys — skip-when-workspace (a
 * Finder-open of an outside file would spawn a window), guard scratch tab,
 * recents restore, temp dir under $HOME removed in teardown. Every write names
 * the fixture's tab id explicitly, so no other tab can be the target. The tab
 * is clean when the journey ends.
 *
 * Waits: every MCP call is a request/response the sidecar bounds itself; the
 * only polls are for the tab bar and editor to reflect the write.
 */

import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeAppTempDir } from "../lib/fixtures.mjs";
import { openFixtureInNewTab } from "../lib/disk.mjs";
import { startVmarkMcp, bridgeReady } from "../lib/vmarkMcp.mjs";
import {
  withTabRestore,
  createScratchTab,
  getTabs,
  getEditorText,
  getPersistedWorkspaceRoot,
  readLocalStorage,
  restoreLocalStorage,
  readLineEndingPreference,
  expectedEol,
  poll,
} from "../lib/vmark.mjs";

const BOM = "﻿";

/** Call the `document` tool and insist it succeeded with a structured payload. */
async function documentOk(mcp, args) {
  const res = await mcp.callTool("document", args);
  if (res.isError) {
    throw new Error(`document ${args.action} was refused: ${res.text.slice(0, 300)}`);
  }
  if (!res.json || typeof res.json !== "object") {
    throw new Error(`document ${args.action} returned no structured payload: ${res.text.slice(0, 300)}`);
  }
  return res.json;
}

export default {
  name: "mcp-document-write",
  coverageRequired: true,

  async run(client, ctx) {
    const root = await getPersistedWorkspaceRoot(client, ctx.windowLabel);
    if (root) {
      return { skip: `workspace open (${root}) — Finder-open of an outside file would spawn a new window` };
    }
    if (!(await bridgeReady())) {
      return { skip: "VMark MCP bridge is not advertising a port" };
    }

    const preference = await readLineEndingPreference(client);
    const EOL = expectedEol("crlf", preference);
    ctx.log(`lineEndingsOnSave="${preference}" → a CRLF document must save with ${EOL === "\r\n" ? "CRLF" : "LF"}`);

    const fixture = await makeAppTempDir();
    let mcp = null;
    try {
      mcp = await startVmarkMcp();
      const filePath = join(fixture.dir, `journey-mcp-write-${fixture.stamp}.md`);
      const original = `${BOM}# MCP 写入\r\n\r\noriginal body ${fixture.stamp}\r\n`;
      await writeFile(filePath, original, "utf8");

      /** What the client sends: LF-only, BOM-free, with CJK. */
      const clientText = `# MCP 写入\n\nwritten by the client ${fixture.stamp}\n\n第二段。\n`;
      const expectedOnDisk = BOM + clientText.replace(/\n/g, EOL);

      const recentsBefore = await readLocalStorage(client, "vmark-recent-files");
      try {
        await withTabRestore(client, async ({ before, track }) => {
          const guard = await createScratchTab(client);
          track(guard.id);
          const fileTab = await openFixtureInNewTab(client, { before, track, guardId: guard.id, filePath });
          await poll(
            () => getEditorText(client),
            (t) => typeof t === "string" && t.includes(`original body ${fixture.stamp}`),
            "fixture content loaded into the editor",
          );

          // ── read: the client sees canonical text and a revision ──
          const first = await documentOk(mcp, { action: "read", tabId: fileTab.id });
          if (first.content !== `# MCP 写入\n\noriginal body ${fixture.stamp}\n`) {
            throw new Error(`read did not return LF, BOM-free text: ${JSON.stringify(first.content)}`);
          }
          if (typeof first.revision !== "string" || first.revision.length === 0) {
            throw new Error(`read returned no revision: ${JSON.stringify(first)}`);
          }

          // ── write: saved, at a new revision ──
          const written = await documentOk(mcp, {
            action: "write",
            tabId: fileTab.id,
            content: clientText,
            expected_revision: first.revision,
          });
          if (written.saved !== true) {
            throw new Error(`write did not report saved:true: ${JSON.stringify(written)}`);
          }
          if (typeof written.revision !== "string" || written.revision === first.revision) {
            throw new Error(`write did not return a new revision: ${JSON.stringify(written)}`);
          }

          // ── ground truth: the whole buffer on disk, BOM and every newline ──
          const onDisk = await readFile(filePath, "utf8");
          if (BOM + onDisk === expectedOnDisk) {
            // Named on its own because it has one cause: the document never
            // learned it had a BOM, so the save had nothing to put back.
            throw new Error(
              `the file lost its BOM: every other byte is right, the leading U+FEFF is gone. ` +
                `The save re-adds a BOM only when the document was opened with one (documentStore hasBom), ` +
                `so check what the open path's file read hands the store for a file that starts with EF BB BF.`,
            );
          }
          if (onDisk !== expectedOnDisk) {
            throw new Error(
              `bytes on disk are not the client's text in the file's convention.\n` +
                `  expected (${expectedOnDisk.length}): ${JSON.stringify(expectedOnDisk)}\n` +
                `  on disk  (${onDisk.length}): ${JSON.stringify(onDisk)}`,
            );
          }

          // ── the app agrees: clean tab, new text in the editor ──
          await poll(
            () => getTabs(client),
            (ts) => ts.find((t) => t.id === fileTab.id)?.dirty === false,
            "the written tab to be clean",
          );
          await poll(
            () => getEditorText(client),
            (t) => typeof t === "string" && t.includes(`written by the client ${fixture.stamp}`) && t.includes("第二段。"),
            "the editor to show the written text",
          );

          // ── the revision the write returned is the document's revision ──
          const second = await documentOk(mcp, { action: "read", tabId: fileTab.id });
          if (second.revision !== written.revision) {
            throw new Error(
              `the revision returned by write (${written.revision}) is not the document's revision (${second.revision}) — ` +
                `the client's next write would be refused as stale`,
            );
          }
          if (second.dirty !== false) throw new Error(`read after a saved write reports dirty: ${JSON.stringify(second.dirty)}`);
          if (second.content !== clientText) {
            throw new Error(`read after write does not return the written text: ${JSON.stringify(second.content)}`);
          }

          // ── a write from the superseded snapshot is refused, and changes nothing ──
          const stale = await mcp.callTool("document", {
            action: "write",
            tabId: fileTab.id,
            content: "overwrite from a stale snapshot\n",
            expected_revision: first.revision,
          });
          if (!stale.isError || !/STALE/.test(stale.text)) {
            throw new Error(`a write with a superseded revision was not refused as STALE: ${stale.text.slice(0, 300)}`);
          }
          if (stale.json?.current_revision !== written.revision) {
            throw new Error(`the STALE refusal does not carry the current revision: ${JSON.stringify(stale.json)}`);
          }
          const afterStale = await readFile(filePath, "utf8");
          if (afterStale !== expectedOnDisk) {
            throw new Error(`a refused write changed the file: ${JSON.stringify(afterStale)}`);
          }
          const tabAfterStale = (await getTabs(client)).find((t) => t.id === fileTab.id);
          if (tabAfterStale?.dirty !== false) throw new Error("a refused write left the tab dirty");
          ctx.log(`document.write saved ${onDisk.length} chars with BOM + ${EOL === "\r\n" ? "CRLF" : "LF"}; stale write refused`);
        });
      } finally {
        try {
          await restoreLocalStorage(client, "vmark-recent-files", recentsBefore);
        } catch (err) {
          ctx.log(`warning: could not restore recent-files (${err?.message ?? err})`);
        }
      }
    } finally {
      try {
        if (mcp) await mcp.close();
      } finally {
        await fixture.cleanup();
      }
    }
  },
};
