/**
 * JSON / JSONL adapter — editor language, validator, and tree preview for JSON files.
 *
 * Real CodeMirror language (@codemirror/lang-json), JSON.parse-based
 * validator that emits ValidationDiagnostic[], and a tree preview via
 * react-json-view-lite (picked as the only candidate with
 * documented keyboard nav + ARIA labelling), loaded when a preview first
 * shows it (LazyJsonTree).
 *
 * JSONL handling: when filePath ends in `.jsonl`, the validator parses
 * each line independently so a single bad line doesn't poison the whole
 * document. Lines that are blank or whitespace-only are skipped.
 *
 * @module lib/formats/adapters/json
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Extension } from "@codemirror/state";
import {
  PackageJsonSchemaRenderer,
  packageJsonSchemaDetector,
} from "./packageJson";
import { LazyJsonTree } from "./LazyJsonTree";
import { registerFormat } from "../registry";
import "./json-tree.css";
import type {
  FormatConfig,
  PreviewRendererProps,
  ValidationDiagnostic,
  Validator,
} from "../types";
import { errorMessage } from "@/utils/errorMessage";
import { jsonErrorOffset } from "@/utils/jsonErrorOffset";

function isJsonlPath(filePath?: string): boolean {
  return Boolean(filePath?.toLowerCase().endsWith(".jsonl"));
}

interface JsonParseError {
  line: number;
  column: number;
  message: string;
}

/**
 * JSON parse error → line/column/message, the same on every engine.
 *
 * The location comes from `jsonErrorOffset`, never from the engine's message:
 * V8 appends "at position N", but JavaScriptCore — VMark's engine on macOS and
 * Linux — reports no position at all, so reading the message put every
 * production error at 1:1 while every Node-run test passed. JavaScriptCore
 * also opens with "JSON Parse error:", which the "JSON: {{message}}" template
 * would repeat, so that prefix is dropped.
 */
function locateParseError(content: string, error: unknown): JsonParseError {
  const message = errorMessage(error).replace(/^JSON Parse error:\s*/i, "");
  const offset = jsonErrorOffset(content) ?? 0;
  const before = content.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - lastNewline,
    message,
  };
}

/** JSON / JSONL validator. Returns one diagnostic per parse error. */
export const jsonValidator: Validator = (content, path) => {
  if (isJsonlPath(path)) {
    const out: ValidationDiagnostic[] = [];
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      try {
        JSON.parse(raw);
      } catch (error) {
        const loc = locateParseError(raw, error);
        out.push({
          severity: "error",
          line: i + 1,
          column: loc.column,
          message: loc.message,
          ruleId: "json/syntax",
        });
      }
    }
    return out;
  }
  if (content.length === 0) {
    // Translation key resolved by the gutter UI; the validator emits
    // a stable ruleId so consumers can localize without parsing the
    // English message.
    return [
      {
        severity: "error",
        line: 1,
        column: 1,
        message: "Empty document",
        ruleId: "json/empty",
      },
    ];
  }
  try {
    JSON.parse(content);
    return [];
  } catch (error) {
    const loc = locateParseError(content, error);
    return [
      {
        severity: "error",
        line: loc.line,
        column: loc.column,
        message: loc.message,
        ruleId: "json/syntax",
      },
    ];
  }
};

function JsonTreePreview({ content, path, diagnostics }: PreviewRendererProps) {
  const { t } = useTranslation("editor");
  const parsed = useMemo(() => {
    try {
      if (isJsonlPath(path ?? undefined)) {
        const lines = content.split(/\r?\n/).filter((l) => l.trim());
        return lines.map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { __error: l };
          }
        });
      }
      return JSON.parse(content);
    } catch {
      return null;
    }
  }, [content, path]);

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
    <div className="json-tree-preview">
      <LazyJsonTree data={parsed} />
    </div>
  );
}

export const jsonFormat: FormatConfig = {
  id: "json",
  nameI18nKey: "format.json",
  extensions: ["json", "jsonl"],
  kind: "split-pane",
  loadLanguage: async (): Promise<Extension> => {
    const { json } = await import("@codemirror/lang-json");
    return json();
  },
  validator: jsonValidator,
  genericPreview: JsonTreePreview,
  schemaDetector: packageJsonSchemaDetector,
  schemaRenderers: {
    "package-json": PackageJsonSchemaRenderer,
  },
  adapters: {
    saveDialogFilters: [{ nameI18nKey: "format.json", extensions: ["json", "jsonl"] }],
    untitledExtension: "json",
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

export function registerJsonFormat(): void {
  registerFormat(jsonFormat);
}
