/**
 * The structured-data tree, loaded when a preview first shows it.
 *
 * Purpose: keep react-json-view-lite off the cold start of every window while
 * the JSON, TOML and YAML previews still draw the same tree.
 *
 * Key decisions:
 *   - `RetryableLazy`, not a bare `Suspense` over a module-level lazy: a
 *     rejected import stays inside the preview pane and its retry loads a fresh
 *     attempt (a module-level lazy replays its cached rejection forever).
 *   - Nothing is drawn while the chunk loads; the source pane beside it is
 *     already showing the document.
 *
 * @coordinates-with lib/formats/adapters/jsonTreeView.tsx — the loaded tree
 * @coordinates-with components/RetryableLazy.tsx — the boundary
 * @module lib/formats/adapters/LazyJsonTree
 */
import { useTranslation } from "react-i18next";
import { RetryableLazy } from "@/components/RetryableLazy";
import type { JsonTreeViewProps } from "./jsonTreeView";

const loadJsonTreeView = () => import("./jsonTreeView");

function JsonTreeLoadError({ retry }: { retry: () => void }) {
  const { t } = useTranslation("editor");
  return (
    <div className="json-tree-preview json-tree-preview--invalid" role="alert">
      <span>{t("preview.failedToLoad")}</span>{" "}
      <button type="button" className="vm-btn" onClick={retry}>
        {t("dialog:errorBoundary.tryAgain")}
      </button>
    </div>
  );
}

/** Draw `data` as a tree, loading the tree view on first use. */
export function LazyJsonTree({ data }: JsonTreeViewProps) {
  return (
    <RetryableLazy
      feature="JSON tree"
      load={loadJsonTreeView}
      componentProps={{ data }}
      pending={null}
      renderError={(retry) => <JsonTreeLoadError retry={retry} />}
    />
  );
}
