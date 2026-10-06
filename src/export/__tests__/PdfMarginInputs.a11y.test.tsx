// WI-RA22.3 — each PDF margin input has an accessible name, from i18n
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PdfSettingsSidebar } from "../PdfSettingsSidebar";
import type { PdfOptions } from "../pdfHtmlTemplate";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function options(): PdfOptions {
  return {
    pageSize: "a4",
    orientation: "portrait",
    marginTop: 25.4,
    marginRight: 12.7,
    marginBottom: 38.1,
    marginLeft: 20,
    fontSize: 11,
    lineHeight: 1.6,
    cjkLetterSpacing: "0.05em",
    latinFont: "system",
    cjkFont: "system",
    useEditorTheme: false,
    pageNumberPosition: "none",
    pageNumberFormat: "plain",
    pageNumberSkipFirst: false,
  };
}

function renderSidebar(onOptionChange = vi.fn()) {
  render(
    <PdfSettingsSidebar
      options={options()}
      onOptionChange={onOptionChange}
      onExport={vi.fn()}
      exporting={false}
      exportStage=""
    />,
  );
  return onOptionChange;
}

describe("PDF margin inputs are named", () => {
  it.each([
    ["Top margin", 25.4],
    ["Right margin", 12.7],
    ["Bottom margin", 38.1],
    ["Left margin", 20],
  ])("finds %s by role and name, showing its own value", (name, value) => {
    renderSidebar();
    expect(screen.getByRole("spinbutton", { name })).toHaveValue(value);
  });

  it("gives the four inputs four distinct names", () => {
    renderSidebar();
    const names = screen
      .getAllByRole("spinbutton")
      .filter((el) => el.classList.contains("margin-layout-input"))
      .map((el) => el.getAttribute("aria-label"));
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
  });

  it("edits the side the name says", async () => {
    function Harness() {
      const [opts, setOpts] = useState(options);
      return (
        <PdfSettingsSidebar
          options={opts}
          onOptionChange={(key, value) => setOpts((o) => ({ ...o, [key]: value }))}
          onExport={vi.fn()}
          exporting={false}
          exportStage=""
        />
      );
    }
    render(<Harness />);
    const left = screen.getByRole("spinbutton", { name: "Left margin" });
    await userEvent.tripleClick(left);
    await userEvent.keyboard("15");

    expect(screen.getByRole("spinbutton", { name: "Left margin" })).toHaveValue(15);
    expect(screen.getByRole("spinbutton", { name: "Top margin" })).toHaveValue(25.4);
    expect(screen.getByRole("spinbutton", { name: "Right margin" })).toHaveValue(12.7);
    expect(screen.getByRole("spinbutton", { name: "Bottom margin" })).toHaveValue(38.1);
  });
});
