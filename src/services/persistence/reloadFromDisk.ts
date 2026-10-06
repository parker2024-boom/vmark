/**
 * Shared helper for reloading a tab's document from disk.
 *
 * Used by:
 * - useExternalFileChanges (auto-reload, user-confirmed reload)
 * - MCP bridge workspaceHandlers (workspace.reloadDocument)
 *
 * @module services/persistence/reloadFromDisk
 */

import { readDocumentText } from "@/services/files/readDocumentText";
import { useDocumentStore } from "@/stores/documentStore";

/**
 * Reload a tab's document content from disk.
 *
 * Reads the file, detects linebreak style, updates the document store,
 * and clears any "missing" flag.
 *
 * @throws If the read fails: file deleted, unreadable, or in an encoding
 * `readDocumentText` refuses (UTF-16/UTF-32)
 */
export async function reloadTabFromDisk(tabId: string, filePath: string): Promise<void> {
  const content = await readDocumentText(filePath);
  const docStore = useDocumentStore.getState();
  docStore.ingestExternalContent(tabId, content, "disk-open", { filePath });
  docStore.clearMissing(tabId);
}
