/**
 * Dirty-Document Contexts
 *
 * Purpose: the single answer to "which open documents still need saving", for
 *   every flow that must bring documents to rest before it destroys them — the
 *   whole-window close and Save All and Quit.
 *
 * Key decisions:
 *   - TABS are iterated, never the document store. A document with no live tab
 *     is not an open document: nothing may prompt for it, and nothing may
 *     write it.
 *   - Dirty AND divergent documents need resolution, the same rule as the
 *     per-tab close. A divergent document — the user kept local content after
 *     an external edit — is clean, but dropping it silently discards exactly
 *     the content the user already chose once to keep.
 *   - One synchronous pass. No await separates the check from the context, so
 *     a context describes the document as it is at collection time.
 *   - The revalidation bound lives here, so every flow that loops agrees on
 *     when "would not come to rest" becomes a refusal.
 *
 * @coordinates-with windowCloseFlow.ts — the window close loop
 * @coordinates-with services/files/saveAllQuit.ts — the Save All and Quit loop
 * @coordinates-with closeSaveShared.ts — the context shape
 * @module services/windowClose/dirtyContexts
 */

import { useDocumentStore, type DocumentState } from "@/stores/documentStore";
import type { Tab } from "@/stores/tabStoreTypes";
import type { CloseSaveContext } from "./closeSaveShared";

/** A document needs resolving when it is dirty OR divergent. */
export function needsResolution(doc: Pick<DocumentState, "isDirty" | "isDivergent">): boolean {
  return doc.isDirty || doc.isDivergent;
}

/**
 * Bound on revalidate iterations. Each pass means "a document changed while we
 * were saving or asking" — twice is a race, three times is a hostile concurrent
 * writer, and at that point refusing to proceed loses nothing.
 */
export const MAX_RESOLUTION_ATTEMPTS = 3;

const NO_TABS: ReadonlySet<string> = new Set();
const NO_SETTLED: ReadonlyMap<string, string> = new Map();

/**
 * The save contexts for the tabs of one window that still need resolving.
 *
 * `discarded` names tabs the user explicitly chose not to save. `settled` maps
 * a tab to the content of a COMPLETED save: a document whose buffer is
 * byte-identical to it is at rest even with `isDirty` standing, and any real
 * edit changes the content and voids the exemption.
 */
export function collectDirtyContexts(
  windowLabel: string,
  tabs: readonly Tab[],
  discarded: ReadonlySet<string> = NO_TABS,
  settled: ReadonlyMap<string, string> = NO_SETTLED,
): CloseSaveContext[] {
  const contexts: CloseSaveContext[] = [];
  for (const tab of tabs) {
    if (discarded.has(tab.id)) continue;
    const doc = useDocumentStore.getState().getDocument(tab.id);
    if (!doc || !needsResolution(doc)) continue;
    // A doc whose buffer is byte-identical to the content we just saved is at
    // rest: save-time normalization (hard-break style) can leave isDirty
    // standing with the bytes safely on disk, and re-prompting looped three
    // identical dialogs then refused the close.
    if (doc.content === settled.get(tab.id)) continue;
    contexts.push({
      windowLabel,
      tabId: tab.id,
      title: doc.filePath || tab.title,
      filePath: doc.filePath,
      content: doc.content,
      divergent: !doc.isDirty && doc.isDivergent,
    });
  }
  return contexts;
}
