/**
 * YAML adapter — editor language, validation, and tree or workflow preview for YAML files.
 *
 * Real CodeMirror language (@codemirror/lang-yaml) + `yaml`-library validator.
 * Tree preview shares the
 * react-json-view-lite component used by the JSON/TOML adapters
 * (LazyJsonTree, loaded on first use).
 *
 * The GHA-workflow schemaDetector is wired into this adapter.
 *
 * yaml is in the ALWAYS-ON trio, so every static import here is cold
 * start for every window, including the ones with no editor. The workbench +
 * workflow IR parser moved behind `React.lazy` (./yamlWorkflowRenderer), the
 * CodeMirror pack behind the `language`/`loadLanguage` thunks, and the GHA
 * source extensions behind dynamic imports inside `loadExtraExtensions` —
 * which was already async, so nothing but the import site changed.
 *
 * @module lib/formats/adapters/yaml
 */

import { useMemo, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import type { Extension } from "@codemirror/state";
import { parse as parseYaml } from "yaml";
import { RetryableLazy } from "@/components/RetryableLazy";
import { loadWorkflowSourceExtensions } from "./yamlWorkflowExtensions";
import { LazyJsonTree } from "./LazyJsonTree";
import "./json-tree.css";
import {
  isWorkflowYaml,
  looksLikeWorkflowPath,
} from "@/lib/ghaWorkflow/detection";
import { isEngineWorkflow } from "@/lib/workflow/detection";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";
import { lintYaml } from "@/lib/lintEngine/yaml";
import { registerFormat } from "../registry";
import type {
  FormatConfig,
  PreviewRendererProps,
  SchemaDetector,
  ValidationDiagnostic,
  Validator,
} from "../types";
import { errorMessage } from "@/utils/errorMessage";

interface YamlException extends Error {
  /** `yaml` library reports positions as 1-based { line, col } in `linePos`. */
  linePos?: Array<{ line: number; col: number }>;
}

/** The CodeMirror YAML pack, loaded on demand. */
const loadYamlLanguage = async (): Promise<Extension> => {
  const { yaml } = await import("@codemirror/lang-yaml");
  return yaml();
};

export const yamlValidator: Validator = (content) => {
  if (content.length === 0) return [];
  try {
    parseYaml(content);
    return [];
  } catch (error) {
    const err = error as YamlException;
    // `yaml` positions are already 1-based — use directly for the gutter.
    const pos = err.linePos?.[0];
    const line = pos?.line ?? 1;
    const column = pos?.col ?? 1;
    const message = errorMessage(err);
    return [
      {
        severity: "error",
        line,
        column,
        message,
        ruleId: "yaml/syntax",
      } satisfies ValidationDiagnostic,
    ];
  }
};

/**
 * GitHub Actions workflow schema detector.
 *
 * ADR-5 precedence:
 *   1. Path detection wins. A file under `.github/workflows/` routes
 *      to the workflow renderer even with malformed YAML so the user
 *      sees a degraded view with diagnostics.
 *   2. Content detection on syntactically invalid content returns null
 *      — the regex-based shape check is gated on a successful YAML
 *      parse so a regex hit on broken YAML doesn't false-positive.
 *
 * WI-LX2.1 — between the two, a VMark ENGINE workflow (top-level `steps:`
 * naming `genie/`/`action/`/`webhook/`, no `jobs:`) is `vmark-workflow`. The
 * shapes are disjoint; `lib/workflow/detection.ts` states the rule.
 */
export const yamlSchemaDetector: SchemaDetector = (path, content) => {
  if (looksLikeWorkflowPath(path)) return "gha-workflow";
  if (isEngineWorkflow(path, content)) return "vmark-workflow";
  // Cheap shape pre-filter before the parse — if the regex doesn't
  // match, we can return null without paying for the YAML parse.
  if (!isWorkflowYaml(content)) return null;
  // Per ADR-5: content detection on syntactically invalid content
  // returns null. Run the parser; on failure, decline.
  try {
    parseYaml(content);
  } catch {
    return null;
  }
  return "gha-workflow";
};

/**
 * GitHub Actions workflow schemaRenderer.
 *
 * The renderer itself (workflow IR parse + the workbench + its xyflow canvas)
 * lives in ./yamlWorkflowRenderer and is loaded on demand: it moved out
 * because this adapter is always registered, so a static reference put the
 * whole workbench on every window's cold start.
 *
 * The boundary is HERE rather than at the host: `schemaRenderers` is a plain
 * `ComponentType` map and SplitPaneEditor mounts whatever it finds, so a bare
 * lazy component would suspend — and REJECT — into whichever boundary happened
 * to be above it.
 *
 * A bare `Suspense` over a module-level `React.lazy` let a
 * rejected import escape to the editor-wide boundary, whose retry replayed the
 * cached rejection forever. `RetryableLazy` mounts a fresh lazy per attempt
 * behind a local boundary, so the failure stays in the pane and retry works.
 */
const loadGhaWorkflowRenderer = () =>
  import("./yamlWorkflowRenderer").then((m) => ({
    default: m.GhaWorkflowSchemaRenderer,
  }));

function GhaWorkflowRendererError({ retry }: { retry: () => void }) {
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

/** The workflow preview over a chunk loader — a parameter, because a module
 *  registry never re-fails a module that resolved once, and failure is tested. */
export function ghaWorkflowRendererOver(
  load: () => Promise<{ default: ComponentType<PreviewRendererProps> }>,
): ComponentType<PreviewRendererProps> {
  return function GhaWorkflowSchemaRenderer(props: PreviewRendererProps) {
    return (
      <RetryableLazy
        feature="GitHub Actions workflow"
        load={load}
        componentProps={props}
        // Fallback is null — the split pane already shows the source side.
        pending={null}
        renderError={(retry) => <GhaWorkflowRendererError retry={retry} />}
      />
    );
  };
}

const GhaWorkflowSchemaRenderer = ghaWorkflowRendererOver(loadGhaWorkflowRenderer);

/**
 * WI-LX2.1 — the `vmark-workflow` schema: the engine's Run/Cancel panel while
 * `advanced.workflowEngine` is on, and otherwise the plain YAML tree the file
 * always showed. Gated HERE, before the lazy import, so the panel's chunk is
 * never fetched for a user who has not turned the engine on; read reactively,
 * so flipping the setting swaps the pane without reopening the file.
 *
 * EXCEPT while this tab's run is live: switching the
 * engine off reaches the backend asynchronously, and a lost push leaves the
 * run going. The panel — and its Cancel — stays until the run ends, which is
 * also what the backend does on acknowledging the disable. The generic preview
 * keeps it too, for a run whose file stopped parsing mid-run.
 */
const loadEngineWorkflowRenderer = () =>
  import("./yamlEngineRenderer").then((m) => ({
    default: m.EngineWorkflowSchemaRenderer,
  }));

/** This tab owns the window's live workflow run. */
function useLiveRunHere(tabId: string | null | undefined): boolean {
  return useWorkflowStore(
    (s) => tabId != null && s.preview.executionId !== null && s.preview.runTabId === tabId,
  );
}

function EngineWorkflowSchemaRenderer(props: PreviewRendererProps) {
  const engineEnabled = useSettingsStore((s) => s.advanced.workflowEngine);
  const liveRunHere = useLiveRunHere(props.tabId);
  if (!engineEnabled && !liveRunHere) return <YamlTreePreview {...props} />;
  return <EngineRunPanel {...props} />;
}

/** Plain YAML — unless this tab's run is live, whose Cancel must stay reachable. */
function YamlGenericPreview(props: PreviewRendererProps) {
  return useLiveRunHere(props.tabId) ? <EngineRunPanel {...props} /> : <YamlTreePreview {...props} />;
}

function EngineRunPanel(props: PreviewRendererProps) {
  return (
    <RetryableLazy
      feature="VMark workflow engine"
      load={loadEngineWorkflowRenderer}
      componentProps={props}
      pending={null}
      renderError={(retry) => <GhaWorkflowRendererError retry={retry} />}
    />
  );
}

function YamlTreePreview({ content, diagnostics }: PreviewRendererProps) {
  const { t } = useTranslation("editor");
  const parsed = useMemo(() => {
    try {
      return parseYaml(content);
    } catch {
      return null;
    }
  }, [content]);

  if (parsed == null) {
    return (
      <div className="json-tree-preview json-tree-preview--invalid">
        <span>{t("preview.cannotRender")}</span>
        {diagnostics[0] && (
          <span className="json-tree-preview__hint">
            {" "}
            {t("preview.errorAt", {
              line: diagnostics[0].line,
              column: diagnostics[0].column,
            })}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="json-tree-preview" data-format="yaml">
      <LazyJsonTree data={parsed} />
    </div>
  );
}

export const yamlFormat: FormatConfig = {
  id: "yaml",
  nameI18nKey: "format.yaml",
  extensions: ["yaml", "yml"],
  kind: "split-pane",
  // One loader, two fields: `language` is what a WYSIWYG-kind host reads and
  // `loadLanguage` what the split pane reads. Both are thunks now, so
  // there is nothing left to duplicate — a second copy would just be a second
  // place to forget.
  language: loadYamlLanguage,
  loadLanguage: loadYamlLanguage,
  lint: (source: string) => lintYaml(source),
  // GHA workflow editor behavior for the source pane. Dynamic imports:
  // these four CodeMirror extensions are a megabyte of
  // source-editor machinery that only a mounted YAML source pane can use.
  // They load INDIVIDUALLY and degrade individually —
  // see ./yamlWorkflowExtensions, which also owns the store binding the
  // plugins must not carry themselves (lint:store-coupling).
  loadExtraExtensions: loadWorkflowSourceExtensions,
  validator: yamlValidator,
  genericPreview: YamlGenericPreview,
  schemaDetector: yamlSchemaDetector,
  schemaRenderers: {
    "gha-workflow": GhaWorkflowSchemaRenderer,
    "vmark-workflow": EngineWorkflowSchemaRenderer,
  },
  adapters: {
    saveDialogFilters: [{ nameI18nKey: "format.yaml", extensions: ["yaml", "yml"] }],
    untitledExtension: "yaml",
    exportEnabled: false,
    findEnabled: true,
    contentSearchIndexed: true,
    readOnlyDefault: false,
    reloadPolicy: "reload",
    menuPolicy: {
      sourceWysiwygToggle: false,
      cjkFormatActions: false,
      insertBlockActions: false,
      paragraphFormatting: false,
    },
    closeSavePolicy: "prompt-on-close",
  },
};

export function registerYamlFormat(): void {
  registerFormat(yamlFormat);
}
