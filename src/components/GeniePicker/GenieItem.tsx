/**
 * Genie Item
 *
 * A single genie entry in the GeniePicker list.
 *
 * @module components/GeniePicker/GenieItem
 */

import type { GenieDefinition } from "@/types/aiGenies";

interface GenieItemProps {
  genie: GenieDefinition;
  index: number;
  selected: boolean;
  onSelect: (genie: GenieDefinition) => void;
  onHover: (index: number) => void;
}

/** Renders a single genie entry in the GeniePicker list with name, description, and scope. */
export function GenieItem({
  genie,
  index,
  selected,
  onSelect,
  onHover,
}: GenieItemProps) {
  return (
    <div
      className={`genie-picker-item ${selected ? "genie-picker-item--selected" : ""}`}
      data-index={index}
      role="option"
      id={`genie-item-${index}`}
      aria-selected={selected}
      onClick={() => onSelect(genie)}
      onMouseEnter={() => onHover(index)}
    >
      <div className="genie-picker-item-name">
        {formatName(genie.metadata.name)}
      </div>
      <div className="genie-picker-item-meta">
        {genie.metadata.description && (
          <span className="genie-picker-item-desc">
            {genie.metadata.description}
          </span>
        )}
        <span className="genie-picker-item-scope">
          {genie.metadata.scope}
        </span>
      </div>
    </div>
  );
}

/** Convert a kebab-case genie name to Title Case (e.g. "fix-grammar" to "Fix Grammar"). */
export function formatName(name: string): string {
  return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
