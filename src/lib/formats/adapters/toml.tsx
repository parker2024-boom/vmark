/**
 * TOML adapter — editor highlighting, validation, and tree preview for TOML files.
 *
 * CodeMirror highlighting via @codemirror/legacy-modes/mode/toml (the
 * pack the project already pulls in via @codemirror/language-data).
 * Validation via smol-toml — picked over @iarna/toml
 * (actively maintained, prior CVEs all fixed in 1.6.1).
 * Tree preview via the same react-json-view-lite component used by
 * the JSON adapter — TOML parses to a plain object, so the renderer
 * is shared (LazyJsonTree, loaded on first use). smol-toml itself loads
 * on first use too (tomlParser.ts): until it arrives the validator reports
 * nothing and the preview is empty, and `validatorUpdates` has the source
 * pane and the preview run again once it has.
 *
 * @module lib/formats/adapters/toml
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Extension } from "@codemirror/state";
import { onTomlParserLoaded, tomlParser, useTomlParser } from "./tomlParser";
import { LazyJsonTree } from "./LazyJsonTree";
import {
  CargoTomlSchemaRenderer,
  cargoTomlSchemaDetector,
} from "./cargoToml";
import {
  PyprojectTomlSchemaRenderer,
  pyprojectTomlSchemaDetector,
} from "./pyprojectToml";
import { registerFormat } from "../registry";
import "./json-tree.css";
import type {
  FormatConfig,
  PreviewRendererProps,
  ValidationDiagnostic,
  Validator,
} from "../types";
import { errorMessage } from "@/utils/errorMessage";

interface TomlError extends Error {
  line?: number;
  column?: number;
  /** smol-toml uses zero-based offsets in some paths; defensive read. */
  pos?: number;
}

export const tomlValidator: Validator = (content) => {
  if (content.length === 0) return [];
  // No findings until the parser has loaded; `validatorUpdates` re-runs us.
  const parseToml = tomlParser();
  if (!parseToml) return [];
  try {
    parseToml(content);
    return [];
  } catch (error) {
    const err = error as TomlError;
    const line = err.line && err.line > 0 ? err.line : 1;
    const column = err.column && err.column > 0 ? err.column : 1;
    const message =
      errorMessage(error);
    return [
      {
        severity: "error",
        line,
        column,
        message,
        ruleId: "toml/syntax",
      } satisfies ValidationDiagnostic,
    ];
  }
};

function TomlTreePreview({ content, diagnostics }: PreviewRendererProps) {
  const { t } = useTranslation("editor");
  const parseToml = useTomlParser();
  const parsed = useMemo(() => {
    if (!parseToml) return undefined;
    try {
      return parseToml(content);
    } catch {
      return null;
    }
  }, [content, parseToml]);

  if (parsed === undefined) return null; // the parser is still loading
  if (parsed === null) {
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
    <div className="json-tree-preview" data-format="toml">
      <LazyJsonTree data={parsed} />
    </div>
  );
}

export const tomlFormat: FormatConfig = {
  id: "toml",
  nameI18nKey: "format.toml",
  extensions: ["toml"],
  kind: "split-pane",
  loadLanguage: async (): Promise<Extension> => {
    const [{ StreamLanguage }, { toml }] = await Promise.all([
      import("@codemirror/language"),
      import("@codemirror/legacy-modes/mode/toml"),
    ]);
    return StreamLanguage.define(toml);
  },
  validator: tomlValidator,
  validatorUpdates: onTomlParserLoaded,
  genericPreview: TomlTreePreview,
  // Composed detector: try Cargo first (filename match wins), then
  // pyproject. Both detectors are pure and side-effect-free.
  schemaDetector: (path, content) =>
    cargoTomlSchemaDetector(path, content) ??
    pyprojectTomlSchemaDetector(path, content),
  schemaRenderers: {
    "cargo-toml": CargoTomlSchemaRenderer,
    "pyproject-toml": PyprojectTomlSchemaRenderer,
  },
  adapters: {
    saveDialogFilters: [{ nameI18nKey: "format.toml", extensions: ["toml"] }],
    untitledExtension: "toml",
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

export function registerTomlFormat(): void {
  registerFormat(tomlFormat);
}
