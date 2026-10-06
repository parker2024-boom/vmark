/**
 * Shared types for source-mode table detection and actions.
 *
 * Extracted to break circular dependency between tableDetection and tableActions.
 *
 * @module plugins/sourceContextDetection/tableTypes
 */

/**
 * Table information in source mode.
 */
export interface SourceTableInfo {
  /** Start position (character offset) of the table */
  start: number;
  /** End position (character offset) of the table */
  end: number;
  /** Line number where table starts (0-indexed) */
  startLine: number;
  /** Line number where table ends (0-indexed) */
  endLine: number;
  /** Current row index (0 = header, 1 = separator, 2+ = data) */
  rowIndex: number;
  /** Current column index (0-indexed) */
  colIndex: number;
  /** Total number of columns */
  colCount: number;
  /** All table lines */
  lines: string[];
}

export type TableAlignment = "left" | "center" | "right";
