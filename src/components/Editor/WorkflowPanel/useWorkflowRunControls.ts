/**
 * useWorkflowRunControls — Run / Cancel for ONE workflow document.
 *
 * Purpose: the logic behind the run panel's toolbar, shared by both places the
 * panel mounts (the yaml split pane and the markdown surface's side panel).
 *
 * Key decisions:
 *   - **The document is the panel's own tab**, read at click time from the
 *     document store (WI-LX2.2). The side panel used to read the active tab of
 *     window `"main"`, so in any other window — or with another tab active —
 *     Run executed a different document, or nothing.
 *   - **A run belongs to the tab that started it** (`preview.runTabId`),
 *     registered WITH the run in one store write — not bound
 *     after `run_workflow` resolves, which left the run nobody's for the
 *     length of the snapshot. Only that tab paints the run's statuses and
 *     offers Cancel, and Cancel names that run's id; any other panel in the
 *     window — or one looking at a workflow genie's run — says Run is busy
 *     instead. A panel remounted mid-start therefore sees its own run. The
 *     runner is one-at-a-time app-wide, so "busy" is the truth.
 *   - The panel subscribes to NOTHING: the window's one event
 *     subscription is held by the approval dialog, and start/cancel are plain
 *     commands.
 *   - **A refused start is SHOWN** — engine off, invalid YAML, already
 *     running, snapshot failed — through `imeToast.errorDetail`, which renders
 *     a typed `CommandError` with `commandErrorMessage`. It used to be logged
 *     and nothing else, so a click on Run could simply do nothing.
 *   - `starting` covers the moment before registration (the start waits for
 *     the window's event subscription). Cancel is offered (`cancellable`)
 *     only for a registered run THIS tab owns — before that there is nothing
 *     of ours to cancel, and a start that loses to another registers nothing.
 *   - A finished run's statuses are painted only while the tab still holds the
 *     text that ran (`preview.runSource`): after an edit, a step sharing an
 *     old id is not the step that succeeded or failed.
 *   - A cancel refused as `not-found` raced the run's own end and is benign;
 *     any other refusal is SHOWN, because the run is still going.
 *
 * @coordinates-with hooks/useWorkflowExecution.ts — startWorkflowRun / cancelWorkflowRun
 * @coordinates-with stores/workflowPreviewSlice.ts — runTabId, the ownership rule
 * @coordinates-with components/Editor/WorkflowPanel/WorkflowRunPanel.tsx — the UI
 * @module components/Editor/WorkflowPanel/useWorkflowRunControls
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { cancelWorkflowRun, startWorkflowRun } from "@/hooks/useWorkflowExecution";
import { useWorkflowStore, type WorkflowRunOutcome } from "@/stores/workflowStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { imeToast as toast } from "@/services/ime/imeToast";
import { isCommandErrorCode } from "@/services/commands/commandError";
import { workflowWarn } from "@/utils/debug";
import type { StepStatusEntry } from "@/lib/workflow/types";

/** Why Run is unavailable — each is an i18n key under `workflow:run.*`. */
type RunBlockedReason = "needsWorkspace" | "busy";

export interface WorkflowRunControls {
  /** This tab started the window's current or last run. */
  owned: boolean;
  /** A run this tab owns is live, or is being started. */
  running: boolean;
  /** A registered run THIS tab owns is live — Cancel reaches exactly it. */
  cancellable: boolean;
  blockedReason: RunBlockedReason | null;
  /** How this tab's last run ended, once it has. */
  outcome: WorkflowRunOutcome | null;
  /** Statuses — only for the run this tab owns, over the text it ran. */
  stepStatuses: Record<string, StepStatusEntry> | undefined;
  run: () => Promise<void>;
  cancel: () => void;
}

export function useWorkflowRunControls(tabId: string | null): WorkflowRunControls {
  // Loads the `workflow` namespace; a bare `useTranslation()` never does, so a
  // `workflow:` key would render its English default in every language.
  const { t } = useTranslation("workflow");
  const [starting, setStarting] = useState(false);
  const executionId = useWorkflowStore((s) => s.preview.executionId);
  const runTabId = useWorkflowStore((s) => s.preview.runTabId);
  const lastRunOutcome = useWorkflowStore((s) => s.preview.lastRunOutcome);
  const stepStatuses = useWorkflowStore((s) => s.preview.stepStatuses);
  const runSource = useWorkflowStore((s) => s.preview.runSource);
  const content = useDocumentStore((s) => (tabId ? s.documents?.[tabId]?.content : undefined));
  const workspaceRoot = useWorkspaceStore((s) => s.rootPath);

  const owned = tabId !== null && runTabId === tabId;
  const cancellable = owned && executionId !== null;
  const running = starting || cancellable;
  const blockedReason: RunBlockedReason | null = !workspaceRoot
    ? "needsWorkspace"
    : executionId !== null && !running
      ? "busy"
      : null;

  const run = useCallback(async () => {
    if (!tabId) return;
    const yaml = useDocumentStore.getState().documents?.[tabId]?.content ?? "";
    const root = useWorkspaceStore.getState().rootPath;
    if (!root || yaml.trim().length === 0) return;
    setStarting(true);
    try {
      await startWorkflowRun({ yaml, workspaceRoot: root, ownerTabId: tabId });
    } catch (error) {
      workflowWarn("Workflow run failed to start:", error);
      toast.errorDetail(t("workflow:run.failedToStart"), error);
    } finally {
      setStarting(false);
    }
  }, [t, tabId]);

  const cancel = useCallback(() => {
    // The run THIS tab owns, by id — never whatever the store holds now.
    const preview = useWorkflowStore.getState().preview;
    if (tabId === null || preview.runTabId !== tabId || preview.executionId === null) return;
    cancelWorkflowRun(preview.executionId).catch((error: unknown) => {
      workflowWarn("Workflow cancel refused:", error);
      // Racing the run's own end is refused `not-found` — benign. Anything
      // else means the run is still going, and the user asked it to stop.
      if (!isCommandErrorCode(error, "not-found")) {
        toast.errorDetail(t("workflow:run.cancelFailed"), error);
      }
    });
  }, [t, tabId]);

  return {
    owned,
    running,
    cancellable,
    blockedReason,
    outcome: owned && executionId === null ? lastRunOutcome : null,
    stepStatuses: owned && runSource !== null && content === runSource ? stepStatuses : undefined,
    run,
    cancel,
  };
}
