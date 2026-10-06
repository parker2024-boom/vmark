/**
 * Layout primitives for the PDF export sidebar.
 *
 * Purpose: these three are pure presentation — an icon-plus-items row, a
 * disclosure wrapper, and the margin diagram. None of them knows what a
 * `PdfOptions` is. Separating them leaves `PdfSettingsSidebar.tsx` as the
 * composition of settings it is meant to be, rather than that plus a small
 * widget library.
 *
 * @module export/PdfSidebarPrimitives
 * @coordinates-with PdfSettingsSidebar.tsx — the only consumer
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";

import "./pdf-margin-layout.css";

/** An icon gutter beside a column of setting rows. */
export function PdfSettingsGroup({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="pdf-settings-group">
      <div className="pdf-settings-group-icon">{icon}</div>
      <div className="pdf-settings-group-items">{children}</div>
    </div>
  );
}

/** Collapsible section for the sidebar. */
export function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: "0.5rem" }}>
      <button
        className="pdf-collapsible-header"
        data-open={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight />
        {title}
      </button>
      {open && children}
    </div>
  );
}

export type MarginSide = "marginTop" | "marginRight" | "marginBottom" | "marginLeft";

/** The range a page margin may take, in millimetres. */
const MARGIN_MIN = 0;
const MARGIN_MAX = 100;

/** One decimal, matching the field's step. */
const roundMargin = (mm: number) => Math.round(mm * 10) / 10;

/**
 * One margin field.
 *
 * Extracted because the same input existed four times, differing only by side
 * and value — and the duplication had already propagated a defect: every copy
 * declared `step={1}` while the shipped presets are 25.4, 12.7 and 38.1mm, so
 * the field was step-mismatched and the spinner snapped away the fraction.
 * Fixing that once meant fixing it four times, which is the argument.
 *
 * The rounding to one decimal matches `step` deliberately: A4's 25.4mm is an
 * inch, and letting it become 25 silently changes the page geometry.
 *
 * While the field is being edited it shows what was typed (`draft`), so it can
 * be emptied on the way to a new number; a controlled input that ignored an
 * empty value snapped back the moment it was cleared. A valid in-range number
 * is applied as it is typed, so the preview follows. Leaving the field, or
 * Enter, settles it: out-of-range is clamped, and empty or unreadable restores
 * the last value.
 */
function MarginInput({
  side, value, label, onChange,
}: {
  side: MarginSide;
  value: number;
  label: string;
  onChange: (side: MarginSide, value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const settle = () => {
    if (draft === null) return;
    const typed = parseFloat(draft);
    const next = Number.isNaN(typed) ? value : roundMargin(Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, typed)));
    if (next !== value) onChange(side, next);
    setDraft(null);
  };

  return (
    <input
      type="number"
      className="margin-layout-input"
      aria-label={label}
      value={draft ?? value}
      min={MARGIN_MIN}
      max={MARGIN_MAX}
      step={0.1}
      onChange={(e) => {
        setDraft(e.target.value);
        const typed = parseFloat(e.target.value);
        if (!Number.isNaN(typed) && typed >= MARGIN_MIN && typed <= MARGIN_MAX) {
          onChange(side, roundMargin(typed));
        }
      }}
      onBlur={settle}
      onKeyDown={(e) => {
        if (e.key === "Enter") settle();
      }}
    />
  );
}

/**
 * Visual page margin diagram with editable mm inputs on all 4 sides.
 *
 * The inputs sit around a drawing with no visible caption, so each takes its
 * accessible name from `sideLabels` — without it a screen reader announced
 * four identical unnamed number fields.
 */
export function MarginLayoutDiagram({
  top, right, bottom, left, landscape, unitLabel, sideLabels, onChange,
}: {
  top: number;
  right: number;
  bottom: number;
  left: number;
  landscape: boolean;
  unitLabel: string;
  sideLabels: Readonly<Record<MarginSide, string>>;
  onChange: (side: MarginSide, value: number) => void;
}) {
  return (
    <div className="margin-layout">
      <div className="margin-layout-top">
        <MarginInput side="marginTop" value={top} label={sideLabels.marginTop} onChange={onChange} />
      </div>
      <div className="margin-layout-middle">
        <MarginInput side="marginLeft" value={left} label={sideLabels.marginLeft} onChange={onChange} />
        <div className={`margin-layout-page ${landscape ? "margin-layout-page--landscape" : ""}`} />
        <MarginInput side="marginRight" value={right} label={sideLabels.marginRight} onChange={onChange} />
      </div>
      <div className="margin-layout-bottom">
        <MarginInput side="marginBottom" value={bottom} label={sideLabels.marginBottom} onChange={onChange} />
      </div>
      <span className="margin-layout-unit">{unitLabel}</span>
    </div>
  );
}
