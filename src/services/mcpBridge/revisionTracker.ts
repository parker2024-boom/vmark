/**
 * Revision Tracker
 *
 * Purpose: Integrates revision tracking with the Tiptap editor — generates
 *   a new revision ID when an EDIT changes the editor's document, so MCP
 *   clients can detect that the document has changed since they read it.
 *
 * Key decisions:
 *   - A programmatic load is not an edit. The editor replaces its whole
 *     document every time it mounts (each tab switch, each pane that shows the
 *     tab) and whenever the store hands it new content; those transactions
 *     carry the `preventUpdate` mark and are ignored here. Counting them made
 *     a revision an MCP client held read as STALE although nothing had
 *     changed. Content that really changes through a load is invalidated where
 *     it changes — the document store bumps the revision on every content
 *     change, and a bridge write bumps it itself.
 *   - Edits are counted HERE, ahead of the store, because keystrokes reach the
 *     store only on a debounced flush; a write based on an older read must be
 *     refused during that window too.
 *
 * @coordinates-with stores/documentStore/revision.ts — stores current revision ID
 * @coordinates-with stores/documentStore/document.ts — bumps the revision when a tab's content changes
 * @coordinates-with components/Editor/TiptapEditor.tsx — calls initializeRevisionTracking on editor creation
 * @coordinates-with components/Editor/tiptapContentLoad.ts — marks the editor's content loads `preventUpdate`
 * @module services/mcpBridge/revisionTracker
 */

import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { useRevisionStore } from "@/stores/documentStore";

/**
 * Hook the editor to update revisions on document edits.
 * Should be called once when the editor is initialized.
 *
 * `tabId` scopes the revision to this editor's document. The
 * editor remounts per tab, so the active tab at mount is this editor's tab.
 */
export function initializeRevisionTracking(editor: Editor, tabId: string): void {
  // Ensure the tab has a revision WITHOUT resetting an existing one. The editor
  // remounts on every tab switch; resetting here would invalidate a revision an
  // MCP client already read for this tab (e.g. a lazily-initialized background
  // tab), causing false STALE rejections. `getRevision` lazily initializes only
  // when absent; real edits bump it via the transaction listener below.
  useRevisionStore.getState().getRevision(tabId);

  editor.on("transaction", ({ transaction }) => {
    if (shouldUpdateRevision(transaction)) {
      useRevisionStore.getState().updateRevision(tabId);
    }
  });
}

/**
 * Whether a transaction is an edit of the document: it changes the document
 * and is not a programmatic load (`preventUpdate`).
 */
function shouldUpdateRevision(tr: Transaction): boolean {
  return tr.docChanged && !tr.getMeta("preventUpdate");
}
