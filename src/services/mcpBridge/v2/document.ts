/**
 * Purpose: `vmark.document.{read, write, transform}` handlers — the read/write spine of the pruned MCP surface.
 *
 *   `read` returns full content + a revision token. `write` replaces
 *   full content (optimistic-concurrency-protected via expected_revision)
 *   AND persists to disk by default — the buffer-vs-disk distinction is
 *   a VMark internal concern that has no business in the AI's reasoning
 *   loop. Set `save: false` to leave changes in-memory only (rare).
 *   `transform` runs the deterministic CJK rewriter — kept because CJK
 *   rules are too nuanced for AI prose to reimplement reliably.
 *
 * Origin: MCP pruning plan (retired) ADR-1, ADR-2, ADR-4.
 *
 * Key decisions:
 *   - Full-content write, not diff. Correctness first; if large-doc
 *     cost ever proves a real problem, add `apply_diff` later.
 *   - `expected_revision` is optional. If absent, we still allow the
 *     write — useful for greenfield "AI types from scratch" flows. When
 *     present, mismatch returns STALE.
 *   - `transform` operates on the whole document, not a selection.
 *   - `write` saves to disk by default. The previous "buffer-only"
 *     behaviour caused AI agents to bypass MCP and write files directly
 *     when they noticed disk was stale — losing checkpoint history and
 *     setting up race conditions with VMark's eventual auto-save. Save
 *     failure does NOT fail the write: the buffer is updated, the
 *     response carries `saved: false` plus EITHER `save_skipped`
 *     (we didn't attempt — opt-out or untitled tab) OR `save_error`
 *     (we attempted and it was refused or rejected). The two fields are
 *     mutually exclusive so AI clients can branch without parsing free-form
 *     text.
 *   - The save is the app's own save (`bridgeSave.ts`), so the file keeps
 *     its line endings and byte-order mark, the write is atomic and ordered
 *     with every other save, and history and provenance are recorded there.
 *     What is saved is the BUFFER as this write left it — the store's
 *     canonical text, not the raw string the client sent. For the tab the
 *     live WYSIWYG editor is showing, that buffer is the editor's
 *     serialization of the client's text, so disk, store and editor agree
 *     and the reply's `saved` and `revision` stay true after the editor
 *     settles (`liveEditor.ts`).
 *   - Every handler resolves its tab through `tabGuard.ts`, which first
 *     flushes the mounted editors into the store — so it reads, checks and
 *     replaces what the user actually has, pending keystrokes included.
 *   - `write` and `transform` refuse BUSY, changing nothing, while the user
 *     is composing with an input method in the editor showing the tab.
 *
 * @coordinates-with tabGuard.ts — tab resolution, the flush, INVALID_TAB and STALE
 * @coordinates-with liveEditor.ts — the mounted WYSIWYG editor ↔ store seam
 * @coordinates-with bridgeSave.ts — the path guard and the save pipeline
 * @coordinates-with checkpoint.ts — the checkpoint a write leaves behind
 * @coordinates-with documentTransform.ts — CJK transform helpers (extracted)
 * @coordinates-with stores/documentStore.ts — content + dirty state
 * @coordinates-with stores/documentStore/revision.ts — the revision token
 * @coordinates-with services/coherence/mcpCapture.ts — MCP read capture; the write is captured by the save pipeline
 * @module services/mcpBridge/v2/document
 */

import { recordMcpRead } from "@/services/coherence/mcpCapture";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { respond } from "@/services/mcpBridge/utils";
import { wrapHandler } from "./wrapHandler";
import { saveTabForBridge } from "./bridgeSave";
import { describeSizeChange, recordBridgeCheckpoint } from "./checkpoint";
import { liveCompositionRefusal, loadIntoLiveWysiwyg } from "./liveEditor";
import { readOperationArgs } from "./readOperationArgs";
import { requireCurrentRevision, requireTab, resolveKind, structuredError } from "./tabGuard";
import {
  applyTransform,
  currentTransformSettings,
  isTransformKind,
  TRANSFORM_KINDS,
} from "./documentTransform";
import type { DocumentKind, V2Error } from "./types";

/**
 * Replace a tab's content and return the revision the document is then at,
 * or BUSY — with nothing changed — while the live WYSIWYG editor showing the
 * tab has an IME composition in progress (`liveEditor.ts`).
 * Does NOT call `respond` — callers decide how to package the result.
 *
 * The store takes the content as an EDIT that keeps the document's disk
 * convention. A Markdown tab the live WYSIWYG editor is showing is then loaded
 * into that editor, which leaves the store holding the editor's serialization
 * (see `liveEditor.ts`); a background or Source-mode tab is store-only — the
 * live editor shows a different document, and dispatching into it would
 * replace that one.
 *
 * The revision is bumped HERE, last, so the token returned is by construction
 * the document's newest: nothing after this point changes the document.
 */
function writeContent(
  tabId: string,
  content: string,
  kind: DocumentKind,
): { revision: string } | V2Error {
  const refusal = liveCompositionRefusal(tabId);
  if (refusal) return refusal;
  useDocumentStore.getState().ingestExternalContent(tabId, content, "mcp-write");
  if (kind === "markdown") loadIntoLiveWysiwyg(tabId, content);
  return { revision: useRevisionStore.getState().updateRevision(tabId) };
}

/**
 * Handle `vmark.document.read`. Args: `{tabId?: string}`.
 */
export async function handleDocumentRead(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  return wrapHandler(id, async () => {
    const wire = readOperationArgs("vmark.document.read", args);
    const tab = await requireTab(id, wire.tabId);
    if (!tab) return;
    const revision = useRevisionStore.getState().getRevision(tab.tabId);
    await respond({
      id,
      success: true,
      data: {
        content: tab.content,
        revision,
        filePath: tab.filePath,
        kind: tab.kind,
        dirty: tab.dirty,
      },
    });
    // Coherence: only a read the client actually RECEIVED joins the
    // next write's inputs, pinned to the content served.
    if (tab.filePath) recordMcpRead(tab.filePath, tab.content, tab.tabId);
  });
}

/**
 * Handle `vmark.document.write`.
 *
 * Args: `{tabId?, content: string, expected_revision?: string, save?: boolean}`.
 *
 * `save` defaults to `true`: after the buffer is updated it is saved
 * through the app's save pipeline, which clears the dirty flag. Untitled
 * tabs (no filePath) skip the save with `saved: false` so the AI can decide
 * whether to call `workspace.save_as`. Save failure leaves the buffer
 * updated; the response surfaces `saved: false, save_error` instead of
 * throwing — re-writing on a transient FS error would lose intent.
 */
export async function handleDocumentWrite(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  return wrapHandler(id, async () => {
    // One parse against the generated contract, not a `typeof` chain
    // restating it. Wrong runtime shape reads as absent.
    const wire = readOperationArgs("vmark.document.write", args);
    if (wire.content === undefined) {
      await structuredError(id, { error: "INTERNAL", message: "content must be a string" });
      return;
    }
    const { content } = wire;
    // `save` defaults to true. AI agents shouldn't have to know about
    // VMark's buffer-vs-disk distinction; the natural mental model is
    // "I wrote the file → file is updated."
    const shouldSave = wire.save !== false;

    const tab = await requireTab(id, wire.tabId);
    if (!tab || !(await requireCurrentRevision(id, tab.tabId, wire.expected_revision))) return;

    const contentBefore = tab.content;
    const revisionBefore = useRevisionStore.getState().getRevision(tab.tabId);
    // Re-detect kind against the INCOMING content. The tab was resolved on
    // its current content, which is empty for fresh untitled tabs — that
    // would default kind=markdown and run YAML writes through Tiptap's
    // markdown parser, garbling the document. The new content is the
    // authoritative source of truth at write time.
    const writeKind = resolveKind(tab.filePath, content);
    const result = writeContent(tab.tabId, content, writeKind);
    if ("error" in result) {
      await structuredError(id, result);
      return;
    }
    // The buffer this write produced, read back from the store BEFORE any
    // await: canonical text (a client may send CRLF; a live WYSIWYG editor
    // re-serializes), and this request's own — a later request can replace
    // the buffer while the save is in flight.
    const buffer = useDocumentStore.getState().documents[tab.tabId]?.content ?? content;
    if (contentBefore !== buffer) {
      recordBridgeCheckpoint({
        tabId: tab.tabId,
        filePath: tab.filePath,
        tool: "document.write",
        description: describeSizeChange("Wrote document", contentBefore, buffer),
        contentBefore,
        revisionBefore,
        revisionAfter: result.revision,
      });
    }

    // Persist to disk by default. The response carries structured fields
    // so AI clients can branch on outcome without parsing prose:
    //   - saved: true                            → buffer updated AND on disk
    //   - saved: false, save_skipped: "opt_out"  → caller passed save:false
    //   - saved: false, save_skipped: "untitled" → no filePath; call save_as
    //   - saved: false, save_error: <message>    → the save was refused or failed
    // save_skipped and save_error are mutually exclusive — the former
    // means "we never tried", the latter means "we tried and failed".
    let saved = false;
    let saveSkipped: "opt_out" | "untitled" | undefined;
    let saveError: string | undefined;
    if (!shouldSave) {
      saveSkipped = "opt_out";
    } else if (!tab.filePath) {
      saveSkipped = "untitled";
    } else {
      const outcome = await saveTabForBridge(tab.tabId, tab.filePath, buffer, "document.write");
      if (outcome.saved) saved = true;
      else saveError = outcome.message;
    }

    await respond({
      id,
      success: true,
      data: {
        ...result,
        saved,
        ...(saveSkipped !== undefined ? { save_skipped: saveSkipped } : {}),
        ...(saveError !== undefined ? { save_error: saveError } : {}),
      },
    });
  });
}

/**
 * Handle `vmark.document.transform`.
 *
 * Args: `{tabId?, kind: "cjk-format" | "cjk-spacing" | "cjk-punctuation",
 * expected_revision?}`.
 */
export async function handleDocumentTransform(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  return wrapHandler(id, async () => {
    const wire = readOperationArgs("vmark.document.transform", args);
    const { kind } = wire;
    if (!isTransformKind(kind)) {
      await structuredError(id, {
        error: "INTERNAL",
        message: `kind must be one of: ${TRANSFORM_KINDS.join(", ")}`,
      });
      return;
    }

    const tab = await requireTab(id, wire.tabId);
    if (!tab || !(await requireCurrentRevision(id, tab.tabId, wire.expected_revision))) return;

    const revisionBefore = useRevisionStore.getState().getRevision(tab.tabId);
    const transformed = applyTransform(kind, tab.content, currentTransformSettings());
    if (transformed === tab.content) {
      await respond({ id, success: true, data: { revision: revisionBefore } });
      return;
    }

    const result = writeContent(tab.tabId, transformed, tab.kind);
    if ("error" in result) {
      await structuredError(id, result);
      return;
    }
    recordBridgeCheckpoint({
      tabId: tab.tabId,
      filePath: tab.filePath,
      tool: "document.transform",
      description: `Transform: ${kind}`,
      contentBefore: tab.content,
      revisionBefore,
      revisionAfter: result.revision,
    });
    await respond({ id, success: true, data: result });
  });
}
