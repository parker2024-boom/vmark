/**
 * useRunSnapshot — "Restore Files" for the run this panel just finished.
 *
 * Purpose: a run with `action/save-file` steps is REFUSED unless its targets
 * are snapshotted first (`prepare.rs`), and until WI-LX2.3 nothing could
 * put a snapshot back. Once this tab's run has ended, look up the snapshot it
 * took; if there is one, offer it, confirm, restore, and say what happened.
 *
 * Key decisions:
 *   - Only the OWNER's finished run is looked up (`owned`, from
 *     `useWorkflowRunControls`), never a live run's: restoring under a running
 *     workflow is refused by Rust anyway, and offering it would invite that.
 *   - The confirmation names the consequence — how many files go back, how
 *     many the run created are deleted, and that later edits are lost —
 *     through the one `confirmAction` funnel (rule: the verb on the button).
 *   - After a COMPLETE restore the offer disappears, for every panel: the run
 *     is marked restored in the workflow store (`markRunRestored`), not in
 *     this hook's state, so a panel mounted later does not offer it again.
 *     The snapshot stays on disk, but a second restore would overwrite edits
 *     made since. A PARTIAL restore keeps the offer — the skipped files are
 *     still unrecovered, and a retry is the only way back to them.
 *   - One restore at a time, from the click on: a ref is taken before the
 *     confirmation opens, and the button is disabled for the whole flow.
 *   - The confirmation is not modal to the runner. Another run can start or
 *     end while it is open, so the choice is re-checked against the store
 *     before anything is written; a superseded restore is refused and said so.
 *   - A failed listing is retried once, then REPORTED: a recovery point that
 *     silently never appears is worse than being told it could not be found.
 *   - The found snapshot is stored WITH the id it was found for, so a stale
 *     answer for an earlier run can never be offered for a later one.
 *
 * @coordinates-with components/Editor/WorkflowPanel/workflowSnapshots.ts — the IPC
 * @coordinates-with components/Editor/WorkflowPanel/WorkflowRunPanel.tsx — the button
 * @module components/Editor/WorkflowPanel/useRunSnapshot
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { useWorkflowStore } from "@/stores/workflowStore";
import { confirmAction } from "@/services/dialogs/confirmAction";
import { imeToast as toast } from "@/services/ime/imeToast";
import { workflowWarn } from "@/utils/debug";
import {
  findRunSnapshot,
  restoreWorkflowSnapshot,
  type SnapshotSummary,
} from "./workflowSnapshots";

export interface RunSnapshot {
  snapshot: SnapshotSummary | null;
  restoring: boolean;
  restore: () => Promise<void>;
}

interface Found {
  forExecutionId: string;
  snapshot: SnapshotSummary | null;
}

/** How long a failed snapshot listing waits before its one retry. */
const LIST_RETRY_MS = 1_000;

export function useRunSnapshot(owned: boolean): RunSnapshot {
  const { t } = useTranslation("workflow");
  const executionId = useWorkflowStore((s) => s.preview.executionId);
  const lastExecutionId = useWorkflowStore((s) => s.preview.lastExecutionId);
  const restoredExecutionId = useWorkflowStore((s) => s.preview.restoredExecutionId);
  const target =
    owned && executionId === null && lastExecutionId !== restoredExecutionId
      ? lastExecutionId
      : null;
  const [found, setFound] = useState<Found | null>(null);
  const [restoring, setRestoring] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const offer = (snapshot: SnapshotSummary | null) => {
      if (!cancelled) setFound({ forExecutionId: target, snapshot });
    };
    findRunSnapshot(target)
      .then(offer)
      .catch((first: unknown) => {
        workflowWarn("Could not list workflow snapshots; retrying once:", first);
        if (cancelled) return;
        retry = setTimeout(() => {
          findRunSnapshot(target)
            .then(offer)
            .catch((error: unknown) => {
              workflowWarn("Could not list workflow snapshots:", error);
              if (!cancelled) toast.errorDetail(i18n.t("workflow:restore.listFailed"), error);
            });
        }, LIST_RETRY_MS);
      });
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [target]);

  const snapshot = found && found.forExecutionId === target ? found.snapshot : null;

  const restore = useCallback(async () => {
    if (!snapshot || !target || inFlight.current) return;
    inFlight.current = true;
    setRestoring(true);
    try {
      const message = [
        snapshot.fileCount > 0
          ? t("workflow:restore.confirmChanged", { count: snapshot.fileCount })
          : null,
        snapshot.createdCount > 0
          ? t("workflow:restore.confirmCreated", { count: snapshot.createdCount })
          : null,
        t("workflow:restore.confirmLoss"),
      ]
        .filter((part): part is string => part !== null)
        .join(" ");
      const confirmed = await confirmAction({
        title: t("workflow:restore.title"),
        message,
        actionLabel: t("workflow:restore.action"),
        kind: "warning",
      });
      if (!confirmed) return;

      // Re-checked AFTER the dialog: a run that started or ended while it was
      // open wrote files this snapshot predates, and restoring would undo them.
      const now = useWorkflowStore.getState().preview;
      if (now.executionId !== null || now.lastExecutionId !== target) {
        toast.warning(t("workflow:restore.superseded"));
        return;
      }

      const report = await restoreWorkflowSnapshot(snapshot.id);
      if (report.skipped > 0) {
        toast.warning(t("workflow:restore.partial", { count: report.skipped }));
      } else {
        toast.success(t("workflow:restore.done"));
        useWorkflowStore.getState().markRunRestored(target);
      }
    } catch (error) {
      toast.errorDetail(t("workflow:restore.failed"), error);
    } finally {
      inFlight.current = false;
      setRestoring(false);
    }
  }, [snapshot, t, target]);

  return { snapshot, restoring, restore };
}
