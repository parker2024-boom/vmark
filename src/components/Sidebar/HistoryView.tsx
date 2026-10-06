/**
 * History View Component
 *
 * Purpose: Displays the active document's version history, with revert and
 *   delete.
 *
 * Key decisions:
 *   - A revert is addressed to the tab and file it was started for. The handler
 *     spans a confirmation dialog and several awaits, and "the active tab" can
 *     be another one by the time each finishes; resolving it afresh loaded the
 *     restored text into whichever tab was focused then.
 *   - The write half of a revert is `restoreSnapshotToFile`, which goes through
 *     the save pipeline. This component only loads what that reports it wrote:
 *     the load is an ingress into the document store, and this is one of its
 *     listed callers.
 *   - The list is refetched after a revert rather than set from the handler, so
 *     a result for a file the sidebar no longer shows is dropped by the same
 *     request check as any other fetch.
 *
 * @coordinates-with services/history/restoreSnapshot.ts — the write half of a revert
 * @coordinates-with services/history/historyOperations.ts — list and delete
 * @module components/Sidebar/HistoryView
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Trash2 } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  useActiveTabId,
  useDocumentFilePath,
  useDocumentActions,
} from "@/hooks/useDocumentState";
import {
  getSnapshots,
  deleteSnapshot,
  type Snapshot,
} from "@/services/history/historyOperations";
import { restoreSnapshotToFile } from "@/services/history/restoreSnapshot";
import { HISTORY_CLEARED_EVENT } from "@/utils/historyTypes";
import { formatSnapshotTime, groupByDay } from "@/utils/dateUtils";
import { historyError } from "@/utils/debug";
import { confirmAction } from "@/services/dialogs/confirmAction";
import i18n from "@/i18n";

/** Renders the document version history sidebar with revert and delete actions. */
export function HistoryView() {
  const { t } = useTranslation("sidebar");
  const tabId = useActiveTabId();
  const filePath = useDocumentFilePath();
  // Pinned to the tab rendered for, so a load issued by a handler that outlives
  // a tab switch still lands in the tab it was started for.
  const { loadContent } = useDocumentActions(tabId);
  const historyEnabled = useSettingsStore((state) => state.general.historyEnabled);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestIdRef = useRef(0);
  const isMutatingRef = useRef(false);

  // Fetch snapshots when filePath changes (with cancellation)
  useEffect(() => {
    // Always increment to cancel any in-flight request
    const currentRequestId = ++requestIdRef.current;

    if (!filePath || !historyEnabled) {
      // Legitimate: clears the list as part of a cancellable async fetch keyed on
      // filePath, not derivable during render (#1063).
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the list inside a cancellable fetch keyed on filePath; not derivable during render
      setSnapshots([]);
      return;
    }

    const fetchSnapshots = async () => {
      setLoading(true);
      try {
        const snaps = await getSnapshots(filePath);
        // Only update if this is still the current request
        if (currentRequestId === requestIdRef.current) {
          setSnapshots(snaps);
        }
      } catch (error) {
        if (currentRequestId === requestIdRef.current) {
          historyError("Failed to fetch snapshots:", error);
          setSnapshots([]);
        }
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    };

    void fetchSnapshots();
  }, [filePath, historyEnabled, refreshKey]);

  // Listen for external clear events (menu actions)
  useEffect(() => {
    const handler = () => setRefreshKey((k) => k + 1);
    window.addEventListener(HISTORY_CLEARED_EVENT, handler);
    return () => window.removeEventListener(HISTORY_CLEARED_EVENT, handler);
  }, []);

  const handleDeleteSnapshot = async (snapshot: Snapshot) => {
    if (!filePath || isMutatingRef.current) return;
    isMutatingRef.current = true;
    try {
      await deleteSnapshot(filePath, snapshot.id);
      setRefreshKey((k) => k + 1);
    } catch (error) {
      historyError("Failed to delete snapshot:", error);
    } finally {
      isMutatingRef.current = false;
    }
  };

  const handleRevert = async (snapshot: Snapshot) => {
    if (!tabId || !filePath || isMutatingRef.current) return;
    isMutatingRef.current = true;

    try {
      const confirmed = await confirmAction({
        title: t("history.revertTitle"),
        message: t("history.revertMessage", { time: formatSnapshotTime(snapshot.timestamp) }),
        actionLabel: i18n.t("dialog:action.revert"),
        kind: "warning",
      });

      if (!confirmed) return;

      const outcome = await restoreSnapshotToFile(tabId, filePath, snapshot.id);
      if (outcome.status === "restored") {
        // The file holds the version now: load what was written as the
        // document's new baseline, into the tab this revert was started for.
        loadContent(outcome.written, filePath);
      }
      // Every outcome that got this far took a safety copy, so the list changed.
      setRefreshKey((k) => k + 1);
    } catch (error) {
      historyError("Failed to revert:", error);
    } finally {
      isMutatingRef.current = false;
    }
  };

  if (!filePath) {
    return (
      <div className="sidebar-view">
        <div className="sidebar-empty">{t("history.saveToEnable")}</div>
      </div>
    );
  }

  if (!historyEnabled) {
    return (
      <div className="sidebar-view">
        <div className="sidebar-empty">{t("history.disabled")}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="sidebar-view">
        <div className="sidebar-empty">{t("loading")}</div>
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="sidebar-view">
        <div className="sidebar-empty">{t("history.noHistory")}</div>
      </div>
    );
  }

  const grouped = groupByDay(snapshots, (s) => s.timestamp);

  return (
    <div className="sidebar-view history-view">
      {Array.from(grouped.entries()).map(([day, daySnapshots]) => (
        <div key={day} className="history-group">
          <div className="history-day">{day}</div>
          {daySnapshots.map((snapshot) => (
            <div key={snapshot.id} className="history-item">
              <div className="history-item-info">
                <span className="history-time">
                  {new Date(snapshot.timestamp).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="history-type">({snapshot.type})</span>
              </div>
              <div className="history-item-actions">
                <button
                  className="vm-icon-btn vm-icon-btn--sm history-action"
                  onClick={() => void handleRevert(snapshot)}
                  title={t("history.revertButton")}
                  aria-label={t("history.revertButton")}
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  className="vm-icon-btn vm-icon-btn--sm vm-icon-btn--danger history-action"
                  onClick={() => void handleDeleteSnapshot(snapshot)}
                  title={t("history.deleteSnapshot")}
                  aria-label={t("history.deleteSnapshot")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
