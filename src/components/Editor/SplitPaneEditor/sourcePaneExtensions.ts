/**
 * sourcePaneExtensions
 *
 * Purpose: Pure builders for SourcePane's CodeMirror wiring — the lint
 * extension (format.validator → gutter + hoisted diagnostics, presented at
 * the severity the path's trust calls for), the base extension list, the
 * diagnostic-to-CodeMirror mapping, the lazy compartment loader
 * (language pack, per-format extras), and `revalidate`, the re-lint a
 * validator asks for when its answer changes (FormatConfig.validatorUpdates). Extracted from SourcePane so its mount
 * effect is a thin assembler. No React, no DOM — unit-testable in isolation.
 *
 * @coordinates-with SourcePane.tsx — sole caller
 * @coordinates-with lib/formats/types — FormatConfig.validator contract
 * @coordinates-with lib/formats/diagnosticPresentation.ts — trust-aware severity
 * @coordinates-with useTrustedSeveritySync.ts — re-presents on trust/path change and
 *   supplies `trustSeverity`, the listener that reconciles each installed lint
 * @module components/Editor/SplitPaneEditor/sourcePaneExtensions
 */
import { Compartment, EditorState, StateEffect, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { forceLinting, linter, type Diagnostic } from "@codemirror/lint";
import { syntaxHighlighting } from "@codemirror/language";
import { useDocumentStore } from "@/stores/documentStore";
import { useUIStore } from "@/stores/uiStore";
import { sourceEditorTheme, codeHighlightStyle } from "@/plugins/codemirror/theme";
import { reducedEditorContextMenuExtension } from "@/plugins/codemirror/editorContextMenu";
import type { FormatConfig, ValidationDiagnostic } from "@/lib/formats/types";
import { presentDiagnostics } from "@/lib/formats/diagnosticPresentation";
import { useHtmlTrustStore } from "@/stores/htmlTrustStore";

/** Whether the user has trusted the document at `path` this session. */
export function isDocumentTrusted(path: string | null | undefined): boolean {
  return path ? useHtmlTrustStore.getState().tokenFor(path) !== null : false;
}


/** What the validator last found, and the document version it found it in. */
export interface RawLint {
  doc: Text;
  diagnostics: readonly ValidationDiagnostic[];
}

/** Map a format ValidationDiagnostic to a CodeMirror Diagnostic, clamping
 *  line/column to the doc's real range so an out-of-range report can't throw
 *  inside doc.line() and break linting. */
/**
 * Reconfigure `compartment` with what `load` resolves to — a lazily loaded
 * language pack or per-format extras — unless the pane unmounted first. A
 * failed load is swallowed: the base editor works without it.
 */
export function reconfigureWhenLoaded(
  viewRef: { readonly current: EditorView | null },
  compartment: Compartment,
  load: () => Promise<Extension>,
  isCancelled: () => boolean,
): void {
  void load()
    .then((extension) => {
      /* v8 ignore next -- @preserve unmount race */
      if (isCancelled() || !viewRef.current) return;
      viewRef.current.dispatch({ effects: compartment.reconfigure(extension) });
    })
    .catch(() => {
      /* v8 ignore next 2 -- @preserve a failed pack falls back to the plain editor */
      /* swallow — the base editor remains functional */
    });
}

export function diagnosticToCodemirror(
  doc: {
    line: (n: number) => { from: number; to: number; length: number };
    lines: number;
  },
  d: ValidationDiagnostic,
): Diagnostic {
  const totalLines = Math.max(1, doc.lines);
  const startLine = Math.min(Math.max(1, d.line), totalLines);
  const lineInfo = doc.line(startLine);
  const from = Math.min(lineInfo.from + Math.max(0, d.column - 1), lineInfo.to);
  let to: number;
  if (d.endLine !== undefined && d.endColumn !== undefined) {
    const endLine = Math.min(Math.max(1, d.endLine), totalLines);
    const endLineInfo = doc.line(endLine);
    to = Math.min(endLineInfo.from + Math.max(0, d.endColumn - 1), endLineInfo.to);
  } else {
    to = Math.min(from + 1, lineInfo.to);
  }
  // No `source` key for a diagnostic with no rule id — CodeMirror renders the
  // source as a badge next to the message, and an empty badge is not the same
  // as no badge.
  return {
    from,
    to: to <= from ? Math.min(from + 1, lineInfo.to) : to,
    severity: d.severity,
    message: d.message,
    ...(d.ruleId !== undefined ? { source: d.ruleId } : {}),
  };
}

/** Build the validator-backed lint extension, or null when the format has no
 *  validator. Hoists the RAW diagnostics to `onDiagnostics` (the validation
 *  list presents them itself) and to `onRawLint` with the document version
 *  they belong to; CodeMirror gets them presented for the path's current
 *  trust (lib/formats/diagnosticPresentation.ts). */
export function buildValidationLinter(
  tabId: string,
  validator: FormatConfig["validator"],
  onDiagnostics: (diagnostics: ValidationDiagnostic[]) => void,
  infoWhenTrusted?: readonly string[],
  onRawLint?: (raw: RawLint) => void,
): Extension | null {
  if (!validator) return null;
  return linter(
    (view) => {
      const text = view.state.doc.toString();
      const path = useDocumentStore.getState().documents?.[tabId]?.filePath ?? undefined;
      const diagnostics = validator(text, path ?? undefined);
      onDiagnostics(diagnostics);
      onRawLint?.({ doc: view.state.doc, diagnostics });
      return presentDiagnostics(diagnostics, infoWhenTrusted, isDocumentTrusted(path))
        .map((d) => diagnosticToCodemirror(view.state.doc, d));
    },
    // Lint runs on document changes; a revalidation also counts.
    { needsRefresh: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(revalidateEffect))) },
  );
}

const revalidateEffect = StateEffect.define<null>();

/**
 * Run the validation linter again on unchanged content — for a validator
 * whose answer changed (FormatConfig.validatorUpdates). `forceLinting` alone
 * does nothing once a lint has run, so the effect marks one as needed first.
 */
export function revalidate(view: EditorView): void {
  view.dispatch({ effects: revalidateEffect.of(null) });
  forceLinting(view);
}

export interface BuildExtensionsArgs {
  tabId: string;
  readOnly: boolean;
  validator: FormatConfig["validator"];
  /** Compartment owning the line-number gutter (toggled in place). */
  lineNumberCompartment: Compartment;
  /** Compartment owning line wrapping (toggled by the Word Wrap setting). */
  lineWrapCompartment: Compartment;
  /** Compartment owning the lazily-loaded language pack. */
  languageCompartment: Compartment;
  /** Compartment owning the lazily-loaded per-format extras
   *  (FormatConfig.loadExtraExtensions). Optional: panes for formats
   *  without extras skip the slot entirely — the caller reads the format's
   *  slot and forwards whatever is there, so `| undefined` is that answer. */
  extrasCompartment?: Compartment | undefined;
  /** Persist-on-change listener (writes documentStore.setContent). */
  persistOnUpdate: Extension;
  /** Hoists lint diagnostics to the preview pane. */
  onDiagnostics: (diagnostics: ValidationDiagnostic[]) => void;
  /** Rule ids shown as info once the document is trusted (FormatConfig). */
  infoWhenTrusted?: readonly string[] | undefined;
  /** Receives each lint's raw findings for useTrustedSeveritySync. */
  onRawLint?: (raw: RawLint) => void;
  /** useTrustedSeveritySync's re-check after every transaction. */
  trustSeverity?: Extension;
}

/** Assemble the full base extension list for the SourcePane editor. */
export function buildSourcePaneExtensions(args: BuildExtensionsArgs): Extension[] {
  const {
    tabId,
    readOnly,
    validator,
    lineNumberCompartment,
    lineWrapCompartment,
    languageCompartment,
    extrasCompartment,
    persistOnUpdate,
    onDiagnostics,
    infoWhenTrusted,
    onRawLint,
    trustSeverity,
  } = args;

  const extensions: Extension[] = [
    // Gutter is compartmentalized so the line-numbers toggle reconfigures it
    // without remounting. Initial state read from the store at mount.
    lineNumberCompartment.of(
      useUIStore.getState().showLineNumbers ? lineNumbers() : [],
    ),
    history(),
    highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    // Line wrapping is compartmentalized so the Word Wrap toggle
    // (uiStore.wordWrap) reconfigures it in place. Previously hardcoded on,
    // which silently ignored the toggle in Split View (#1070).
    lineWrapCompartment.of(
      useUIStore.getState().wordWrap ? EditorView.lineWrapping : [],
    ),
    // Same caret/selection/mono-font theme + GitHub syntax palette the
    // markdown Source editor uses; fallback:true colors tokens before a
    // language pack resolves.
    syntaxHighlighting(codeHighlightStyle, { fallback: true }),
    sourceEditorTheme,
    // Empty initial language — the loadLanguage promise reconfigures this.
    languageCompartment.of([]),
    // Empty initial extras slot — the loadExtraExtensions promise
    // reconfigures this (per-format editor behavior, e.g. yaml's GHA
    // workflow extensions).
    ...(extrasCompartment ? [extrasCompartment.of([])] : []),
    persistOnUpdate,
    // Right-click menu, reduced to clipboard + Select All — split panes
    // have no markdown context detection.
    reducedEditorContextMenuExtension,
  ];

  const validationLinter = buildValidationLinter(tabId, validator, onDiagnostics, infoWhenTrusted, onRawLint);
  if (validationLinter) extensions.push(validationLinter);
  if (validationLinter && trustSeverity) extensions.push(trustSeverity);
  if (readOnly) extensions.push(EditorState.readOnly.of(true));

  return extensions;
}
