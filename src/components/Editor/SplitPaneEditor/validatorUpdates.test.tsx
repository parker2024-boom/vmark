// WI-RA24.9 — a validator whose answer changes for the SAME content (its parser
// loads on first use, as the TOML adapter's now does) is re-run when it says
// so: the source pane re-lints and the preview re-validates, without an edit.
// REAL: SourcePane with its CodeMirror view and the document store, and the
// preview-model hook. The format is a fixture whose validator answers nothing
// until it is "ready".
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { forEachDiagnostic, forceLinting } from "@codemirror/lint";
import type { FormatConfig, ValidationDiagnostic } from "@/lib/formats/types";
import { useDocumentStore } from "@/stores/documentStore";
import { SourcePane } from "./SourcePane";
import { usePreviewModel } from "./usePreviewModel";

const TAB = "tab-validator-updates";
const BAD: ValidationDiagnostic = { severity: "error", line: 1, column: 1, message: "bad value", ruleId: "fixture/bad" };

let ready = false;
const listeners = new Set<() => void>();

/** Ready: the validator now reports, and says so to whoever subscribed. */
function becomeReady(): void {
  ready = true;
  listeners.forEach((listener) => listener());
}

const gatedFormat: FormatConfig = {
  id: "fixture",
  nameI18nKey: "format.txt",
  extensions: ["fixture"],
  kind: "split-pane",
  validator: (text) => (ready && text.includes("bad") ? [BAD] : []),
  validatorUpdates: (listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  adapters: {
    saveDialogFilters: [],
    untitledExtension: "fixture",
    readOnlyDefault: false,
    closeSavePolicy: "prompt-on-close",
    menuPolicy: {
      sourceWysiwygToggle: false,
      cjkFormatActions: false,
      insertBlockActions: false,
      paragraphFormatting: false,
    },
  },
};

function messages(view: EditorView): string[] {
  const out: string[] = [];
  forEachDiagnostic(view.state, (d) => out.push(d.message));
  return out;
}

beforeEach(() => {
  ready = false;
  listeners.clear();
});

afterEach(() => cleanup());

describe("the source pane re-lints when the validator says its answer changed", () => {
  function mount() {
    useDocumentStore.getState().initDocument(TAB, "key = bad\n", "/x/a.fixture");
    const onDiagnostics = vi.fn();
    const r = render(
      <SourcePane tabId={TAB} formatId="fixture" formatConfig={gatedFormat} onDiagnostics={onDiagnostics} />,
    );
    const view = EditorView.findFromDOM(r.container.querySelector(".cm-editor") as HTMLElement)!;
    forceLinting(view);
    return { ...r, view, onDiagnostics };
  }

  it("shows the finding once the validator is ready, with no edit", async () => {
    const { view, onDiagnostics } = mount();
    await waitFor(() => expect(onDiagnostics).toHaveBeenCalledWith([]));
    expect(messages(view)).toEqual([]);

    act(() => becomeReady());

    await waitFor(() => expect(messages(view)).toEqual(["bad value"]));
    expect(onDiagnostics).toHaveBeenLastCalledWith([BAD]);
    expect(view.state.doc.toString()).toBe("key = bad\n");
  });

  it("stops listening when it unmounts", () => {
    const { unmount } = mount();
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});

describe("the preview re-validates when the validator says its answer changed", () => {
  it("reports the finding for the same content once the validator is ready", () => {
    const { result, unmount } = renderHook(() =>
      usePreviewModel({ formatConfig: gatedFormat, content: "key = bad\n", filePath: "/x/a.fixture", activeSchemaId: null }),
    );
    expect(result.current.diagnostics).toEqual([]);

    act(() => becomeReady());

    expect(result.current.diagnostics).toEqual([BAD]);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it("re-runs the schema detector too, so a schema it could not confirm is picked up", () => {
    const Schema = () => null;
    const Generic = () => null;
    const format: FormatConfig = {
      ...gatedFormat,
      genericPreview: Generic,
      schemaRenderers: { fixture: Schema },
      schemaDetector: () => (ready ? "fixture" : null),
    };
    const { result } = renderHook(() =>
      usePreviewModel({ formatConfig: format, content: "key = 1\n", filePath: "/x/a.fixture", activeSchemaId: null }),
    );
    expect(result.current.Preview).toBe(Generic);

    act(() => becomeReady());

    expect(result.current.Preview).toBe(Schema);
  });
});
