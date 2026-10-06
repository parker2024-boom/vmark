/**
 * SplitPaneEditor — trust-aware severity on the validation LIST.
 *
 * The list and CodeMirror's lint are two surfaces for one set of findings;
 * both must present them through the same mapping (presentDiagnostics), or
 * the gutter says "info" while the list still says "warning". The real
 * SourcePane runs the real HTML validator, whose linter reports the script
 * finding after its debounce — so the first assertion awaits it.
 */
import { render, screen, act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDocumentStore } from "@/stores/documentStore";
import { useHtmlTrustStore } from "@/stores/htmlTrustStore";
import { htmlFormat } from "@/lib/formats/adapters/html";
import { SplitPaneEditor } from "./SplitPaneEditor";

const TAB = "tab-list";
const A = "/docs/list-a.html";
const TOKEN = "b".repeat(64);
const rowSeverities = () =>
  [...document.querySelectorAll(".validation-gutter__row")].map((r) => r.getAttribute("data-severity"));

afterEach(() => {
  cleanup();
  useHtmlTrustStore.getState().clearAll();
});

describe("SplitPaneEditor validation list under trust", () => {
  it("lists the script finding as a warning, then info once trusted, then warning after Save As elsewhere", async () => {
    useDocumentStore.getState().initDocument(TAB, "<p>x</p>\n<script>1</script>", A);
    render(<SplitPaneEditor tabId={TAB} formatConfig={htmlFormat} />);
    await waitFor(() => expect(rowSeverities()).toEqual(["warning"]), { timeout: 5000 });
    expect(screen.getByTestId("validation-summary")).toBeInTheDocument();

    act(() => useHtmlTrustStore.getState().grant(A, TOKEN));
    expect(rowSeverities()).toEqual(["info"]);

    act(() => useDocumentStore.getState().setFilePath(TAB, "/docs/list-b.html"));
    expect(rowSeverities()).toEqual(["warning"]);
  });
});
