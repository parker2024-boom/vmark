/**
 * Source Workflow Preview Plugin
 *
 * Purpose: When the MARKDOWN Source editor edits a YAML file (a `.yml`
 * associated with markdown in Settings → Formats — ordinary `.yml` files use
 * the yaml adapter's own `vmark-workflow` preview instead), debounces YAML
 * parsing and feeds the result through `workflowPort` (the workflow store) so
 * the WorkflowSidePanel shows a live React Flow graph.
 *
 * Key decisions (WI-LX2.4):
 *   - Writes ITS tab's preview. The assembly passes the editor's `tabId`, and
 *     every write names it: one unkeyed slot let two split-pane editors
 *     overwrite each other on every re-parse, and either one's teardown
 *     cleared the other's graph and closed its panel.
 *   - Parses the document it OPENS with. It used to wait for a `docChanged`
 *     update, so a workflow file opened as-is never showed its panel until the
 *     user typed.
 *   - Leaving the file clears the graph and closes the panel but leaves the
 *     RUN alone. Resetting the slice dropped a live run's registration, so its
 *     events stopped routing; and `setGraph` keeps the run's step statuses, so
 *     opening, re-parsing or leaving the file mid-run does not erase progress.
 *
 * @coordinates-with workflowPort.ts — the store port that receives graph/parseError (bound to stores/workflowStore.ts)
 * @coordinates-with parser.ts — parseWorkflow, isWorkflowYaml
 * @module plugins/codemirror/sourceWorkflowPreview
 */

import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { workflowPort } from "./workflowPort";
import { parseWorkflow, isWorkflowYaml, WorkflowParseError, WorkflowValidationError } from "@/lib/workflow/parser";
import { workflowLog, workflowWarn } from "@/utils/debug";
import { errorMessage } from "@/utils/errorMessage";

const DEBOUNCE_MS = 300;

class SourceWorkflowPreviewPlugin {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastContent = "";

  constructor(
    view: EditorView,
    private readonly tabId: string,
  ) {
    this.schedule(view.state.doc.toString());
  }

  update(update: ViewUpdate) {
    if (!update.docChanged) return;
    this.schedule(update.state.doc.toString());
  }

  /** Debounced parse of `content`, skipping a repeat of the last one. */
  private schedule(content: string) {
    if (content === this.lastContent) return;
    this.lastContent = content;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.parseAndUpdate(content);
    }, DEBOUNCE_MS);
  }

  private parseAndUpdate(content: string) {
    const port = workflowPort().getState();
    if (!isWorkflowYaml(content)) {
      port.setGraph(this.tabId, null);
      port.previewClosePanel(this.tabId);
      return;
    }

    try {
      const graph = parseWorkflow(content);
      workflowLog("Parsed workflow:", graph.name, `(${graph.steps.length} steps)`);
      port.setGraph(this.tabId, graph);
      // Auto-open the panel when a valid workflow is detected (idempotent).
      port.previewOpenPanel(this.tabId);
    } catch (e) {
      if (e instanceof WorkflowParseError || e instanceof WorkflowValidationError) {
        workflowWarn("Workflow parse error:", e.message);
        port.setGraph(this.tabId, null, e.message);
      } else {
        workflowWarn("Unexpected parse error:", errorMessage(e));
        port.setGraph(this.tabId, null, errorMessage(e));
      }
    }
  }

  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    // Leaving the workflow file: no graph, no panel — and a live run keeps
    // its registration, so its events still route (see the header).
    workflowPort().getState().setGraph(this.tabId, null);
    workflowPort().getState().previewClosePanel(this.tabId);
  }
}

/** The preview for the Source editor of `tabId`. */
export function sourceWorkflowPreviewExtensions(tabId: string): Extension[] {
  return [ViewPlugin.define((view) => new SourceWorkflowPreviewPlugin(view, tabId))];
}
