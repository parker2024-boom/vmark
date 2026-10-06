// WI-RA24.3 — a PDF margin field can be emptied while editing: it commits on
// blur or Enter, clamps an out-of-range value, and restores the last value when
// left empty, instead of snapping back the moment the field is cleared.
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PdfSettingsSidebar } from "../PdfSettingsSidebar";
import type { PdfOptions } from "../pdfHtmlTemplate";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const INITIAL: PdfOptions = {
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

/** The sidebar with real option state, recording every committed change. */
function renderSidebar() {
  const changes: Array<[keyof PdfOptions, unknown]> = [];
  function Harness() {
    const [opts, setOpts] = useState(INITIAL);
    return (
      <PdfSettingsSidebar
        options={opts}
        onOptionChange={(key, value) => {
          changes.push([key, value]);
          setOpts((o) => ({ ...o, [key]: value }));
        }}
        onExport={vi.fn()}
        exporting={false}
        exportStage=""
      />
    );
  }
  render(<Harness />);
  return { changes, user: userEvent.setup() };
}

const field = (name: string) => screen.getByRole("spinbutton", { name });
const marginChanges = (changes: Array<[keyof PdfOptions, unknown]>, side: keyof PdfOptions) =>
  changes.filter(([key]) => key === side).map(([, value]) => value);

describe("editing a PDF margin field", () => {
  it("lets the field be emptied while editing, without committing anything", async () => {
    const { changes, user } = renderSidebar();
    await user.tripleClick(field("Left margin"));
    await user.keyboard("{Backspace}");

    expect(field("Left margin")).toHaveValue(null);
    expect(marginChanges(changes, "marginLeft")).toEqual([]);
  });

  it("commits the new value typed into an emptied field", async () => {
    const { changes, user } = renderSidebar();
    await user.tripleClick(field("Left margin"));
    await user.keyboard("{Backspace}12.5");
    await user.tab();

    expect(field("Left margin")).toHaveValue(12.5);
    expect(marginChanges(changes, "marginLeft").at(-1)).toBe(12.5);
  });

  it("restores the last value when left empty", async () => {
    const { changes, user } = renderSidebar();
    await user.tripleClick(field("Top margin"));
    await user.keyboard("{Backspace}");
    await user.tab();

    expect(field("Top margin")).toHaveValue(25.4);
    expect(marginChanges(changes, "marginTop")).toEqual([]);
  });

  it.each([
    ["Enter", "{Enter}"],
    ["blur", "{Tab}"],
  ])("clamps an out-of-range value to the allowed range on %s", async (_label, commit) => {
    const { changes, user } = renderSidebar();
    await user.tripleClick(field("Right margin"));
    await user.keyboard(`150${commit}`);

    expect(field("Right margin")).toHaveValue(100);
    expect(marginChanges(changes, "marginRight").at(-1)).toBe(100);
  });

  it("clamps a negative value to zero", async () => {
    const { changes, user } = renderSidebar();
    await user.tripleClick(field("Bottom margin"));
    await user.keyboard("-5{Enter}");

    expect(field("Bottom margin")).toHaveValue(0);
    expect(marginChanges(changes, "marginBottom").at(-1)).toBe(0);
  });

  it("rounds to the field's one-decimal step when it commits", async () => {
    const { changes, user } = renderSidebar();
    await user.tripleClick(field("Left margin"));
    await user.keyboard("12.345{Enter}");

    expect(field("Left margin")).toHaveValue(12.3);
    expect(marginChanges(changes, "marginLeft").at(-1)).toBe(12.3);
  });

  it("shows a chosen preset's margins, including in a field that was emptied and abandoned", async () => {
    const { user } = renderSidebar();
    await user.tripleClick(field("Left margin"));
    await user.keyboard("{Backspace}");
    await user.tab();
    const presets = screen
      .getAllByRole("combobox")
      .find((select) => within(select).queryByRole("option", { name: "Narrow" }));
    await user.selectOptions(presets!, "narrow");

    for (const name of ["Top margin", "Right margin", "Bottom margin", "Left margin"]) {
      expect(field(name)).toHaveValue(12.7);
    }
  });

  it("shows a preset chosen while a field is being edited once the edit ends", async () => {
    const { user } = renderSidebar();
    await user.tripleClick(field("Left margin"));
    await user.keyboard("{Backspace}");
    const presets = screen
      .getAllByRole("combobox")
      .find((select) => within(select).queryByRole("option", { name: "Wide" }));
    await user.selectOptions(presets!, "wide"); // focus leaves the emptied field

    expect(field("Left margin")).toHaveValue(38.1);
    expect(field("Right margin")).toHaveValue(38.1);
  });
});
