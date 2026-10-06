/**
 * Open Documents
 *
 * Purpose: the single answer to "which documents are open here" — the document
 *   of each live tab, in every window this webview's stores hold — for flows
 *   that read every open buffer, grant access by what the user has open, or
 *   warn about unsaved work before in-memory state is destroyed.
 *
 * Key decisions:
 *   - TABS are iterated, never the document store. A document with no live tab
 *     is not open: nobody can see it or save it, so nothing may warn about it,
 *     and its buffer may not stand in for the file on disk. Tab removal frees
 *     the document, so there should be none — but a caller that would prompt,
 *     write or delete on the strength of one must not depend on that.
 *   - A tab with no document (a browser tab, or a tab whose file is still
 *     loading) is skipped: there is no buffer to speak of yet.
 *   - Nothing is flushed here. A caller that needs the editors' pending
 *     keystrokes flushes first, as it already had to.
 *
 * @coordinates-with stores/tabStore.ts — the live tabs
 * @coordinates-with stores/documentStore.ts — their documents
 * @coordinates-with services/windowClose/dirtyContexts.ts — the same rule, for the flows that save
 * @coordinates-with services/windowClose/tabCleanup.ts — frees a document when its tab leaves
 * @module services/tabs/openDocuments
 */

import { useDocumentStore, type DocumentState } from "@/stores/documentStore";
import { useTabStore } from "@/stores/tabStore";

/** An open document: a live tab and the document behind it. */
export interface OpenDocument {
  tabId: string;
  doc: DocumentState;
}

/** The document of every live tab, window by window, in tab order. */
export function openDocuments(): OpenDocument[] {
  const { documents } = useDocumentStore.getState();
  const open: OpenDocument[] = [];
  for (const tabs of Object.values(useTabStore.getState().tabs)) {
    for (const tab of tabs) {
      const doc = documents[tab.id];
      if (doc) open.push({ tabId: tab.id, doc });
    }
  }
  return open;
}

/** Tab ids of the open documents that hold unsaved changes. */
export function openDirtyTabIds(): string[] {
  return openDocuments()
    .filter((open) => open.doc.isDirty)
    .map((open) => open.tabId);
}
