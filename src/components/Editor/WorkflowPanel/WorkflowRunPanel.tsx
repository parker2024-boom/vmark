/**
 * WorkflowRunPanel — the VMark workflow engine's Run / Cancel panel.
 *
 * Purpose: one panel body for both places the engine reaches the editor —
 * the yaml adapter's split pane (`vmark-workflow` schema, the normal path for
 * a `.yml` engine workflow) and the markdown surface's side panel
 * (`WorkflowSidePanel`, for a YAML file opened through a markdown
 * association). Each mounts it for ONE tab and hands it the parsed graph.
 *
 * Shows: the toolbar (Run ▶ or Cancel ◼, a status line that says why Run is
 * off or how the last run ended, and Restore Files once this tab's run has
 * a snapshot to put back), then the live step graph or the parse error.
 * Cancel stays disabled, and the status says Starting, until the start has
 * registered a run to cancel. A step selected on the graph is selected in
 * THIS panel only, and only on the graph it was selected on.
 *
 * @coordinates-with components/Editor/WorkflowPanel/useWorkflowRunControls.ts — run / cancel / ownership
 * @coordinates-with components/Editor/WorkflowPanel/useRunSnapshot.ts — Restore Files
 * @coordinates-with plugins/workflowPreview/WorkflowPreview.tsx — the step graph
 * @coordinates-with lib/formats/adapters/yamlEngineRenderer.tsx — the split-pane mount
 * @coordinates-with components/Editor/WorkflowPanel/WorkflowSidePanel.tsx — the side-panel mount
 * @module components/Editor/WorkflowPanel/WorkflowRunPanel
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { WorkflowPreview } from "@/plugins/workflowPreview/WorkflowPreview";
import type { WorkflowGraph } from "@/lib/workflow/types";
import { useWorkflowRunControls } from "./useWorkflowRunControls";
import { useRunSnapshot } from "./useRunSnapshot";
import "./workflow-side-panel.css";

/** Literal keys, so the i18n gates can see every one of them. */
const BLOCKED_KEY = {
  needsWorkspace: "workflow:run.needsWorkspace",
  busy: "workflow:run.busy",
} as const;
const OUTCOME_KEY = {
  completed: "workflow:run.status.completed",
  failed: "workflow:run.status.failed",
  cancelled: "workflow:run.status.cancelled",
} as const;

export interface WorkflowRunPanelProps {
  /** The document this panel runs; null renders the graph read-only. */
  tabId: string | null;
  graph: WorkflowGraph | null;
  parseError: string | null;
}

export function WorkflowRunPanel({ tabId, graph, parseError }: WorkflowRunPanelProps) {
  const { t } = useTranslation(["workflow", "editor"]);
  const controls = useWorkflowRunControls(tabId);
  const { snapshot, restoring, restore } = useRunSnapshot(controls.owned);
  // The selection is THIS panel's, and belongs to the graph it was made on:
  // another tab's panel never shares it, and a re-parse — the yaml
  // adapter's local one included — does not carry it onto an edited workflow.
  const [selection, setSelection] = useState<{ stepId: string; graph: WorkflowGraph } | null>(null);
  const activeStepId = selection !== null && selection.graph === graph ? selection.stepId : null;

  const handleNodeClick = useCallback(
    (stepId: string) => {
      if (graph) setSelection({ stepId, graph });
    },
    [graph],
  );

  const canRun =
    tabId !== null && !!graph && !parseError && !controls.running && !controls.blockedReason;
  const status = controls.running
    ? t(controls.cancellable ? "workflow:run.status.running" : "workflow:run.status.starting")
    : controls.blockedReason
      ? t(BLOCKED_KEY[controls.blockedReason])
      : controls.outcome
        ? t(OUTCOME_KEY[controls.outcome])
        : null;

  return (
    <div className="workflow-side-panel__content">
      <div className="workflow-side-panel__toolbar" role="toolbar">
        {controls.running ? (
          <button
            type="button"
            className="workflow-side-panel__btn workflow-side-panel__btn--cancel"
            onClick={controls.cancel}
            disabled={!controls.cancellable}
            aria-label={t("workflow:run.cancel")}
            title={t("workflow:run.cancel")}
          >
            ◼
          </button>
        ) : (
          <button
            type="button"
            className="workflow-side-panel__btn workflow-side-panel__btn--run"
            onClick={() => void controls.run()}
            disabled={!canRun}
            aria-label={t("workflow:run.start")}
            title={t("workflow:run.start")}
          >
            ▶
          </button>
        )}
        {status && (
          <span className="workflow-side-panel__status" role="status">
            {status}
          </span>
        )}
        {snapshot && !controls.running && (
          <button
            type="button"
            className="vm-btn vm-btn--compact"
            onClick={() => void restore()}
            disabled={restoring}
          >
            {t("workflow:restore.button")}
          </button>
        )}
      </div>
      {parseError ? (
        <div className="workflow-side-panel__error" role="alert">
          <span className="workflow-side-panel__error-icon" aria-hidden="true">
            &#x26A0;
          </span>
          <span className="workflow-side-panel__error-text">{parseError}</span>
        </div>
      ) : graph ? (
        <div className="workflow-preview-canvas">
          <WorkflowPreview
            graph={graph}
            activeStepId={activeStepId}
            {...(controls.stepStatuses ? { stepStatuses: controls.stepStatuses } : {})}
            onNodeClick={handleNodeClick}
          />
        </div>
      ) : (
        <div className="workflow-side-panel__empty">{t("editor:workflow.noPreview")}</div>
      )}
    </div>
  );
}
