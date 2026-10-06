/**
 * Purpose: record the provenance of a finished save — exactly ONE coherence
 * capture per write, attributed to whoever asked for it.
 *
 * A manual or automatic save is a human transformation and goes to the human
 * funnel. An AI client's write over the MCP bridge goes to the MCP capture,
 * which records it as inferred, with the documents the client read this
 * session as its inputs and the tool as its intent. Deciding that here, inside
 * the pipeline, is what keeps the count at one: when the bridge wrote files
 * itself it also captured for itself, and routing it through the pipeline
 * without this split would have recorded every AI write twice — once as the
 * human's.
 *
 * Key decisions:
 *   - Fire-and-forget. A failed capture never fails the save; scan
 *     reconciliation heals gaps. The trailing catch guards that contract even
 *     if a capture ever throws.
 *   - No setting is read here. Stamping a `vmark:` block into the user's file
 *     and creating `.vmark/` are OPT-IN (`general.coherenceCaptureOnSave`,
 *     default off) — autosave once made that rewrite silent. The setting is
 *     enforced ONCE, by the funnel and the kernel, for every write path; a
 *     gate here covered saves only.
 *
 * @coordinates-with saveToPath.ts — the only caller
 * @coordinates-with services/coherence/captureFunnel.ts — the human funnel
 * @coordinates-with services/coherence/mcpCapture.ts — the MCP capture
 * @module services/persistence/saveCapture
 */
import { captureWrite } from "@/services/coherence/captureFunnel";
import { captureMcpWrite } from "@/services/coherence/mcpCapture";
import type { SaveOrigin } from "./saveOutcome";

/** Capture one finished write. `written` is the exact text now on disk. */
export function captureSave(path: string, written: string, origin: SaveOrigin): void {
  if (origin.saveType === "mcp") {
    void captureMcpWrite({
      absolutePath: path,
      content: written,
      toolName: origin.toolName,
    }).catch(() => {});
    return;
  }
  void captureWrite({
    absolutePath: path,
    content: written,
    agent: { type: "human" },
    intent: {
      kind: "editor-save",
      summary: origin.saveType === "auto" ? "auto save" : "manual save",
    },
  }).catch(() => {});
}
