/**
 * Zod schemas for the hot-exit session read boundary.
 *
 * Purpose: structural validation of persisted session payloads BEFORE they
 * reach migration/restore. The payload crosses an IPC boundary (Rust reads the
 * bytes, but both sides migrate independently — "dual migration by design" in
 * schemaMigration.ts — so the frontend must not assume the shape).
 *
 * Key decisions:
 *   - Posture is PASSTHROUGH (decision ledger D5, persistence-read class):
 *     every object schema is loose so unknown fields from newer app versions
 *     survive the boundary; corrupt ≠ unknown.
 *   - Schemas are VALIDATORS, not transformers: callers keep the original
 *     payload objects, so valid data round-trips byte-identically (no
 *     narrowing, no default-filling — migration owns normalization).
 *   - Tolerances mirror the oldest migratable shape (v1): fields added in
 *     later schema versions are optional here because validation runs BEFORE
 *     migration backfills them.
 *   - Only content-integrity fields are strict (tab id, document content);
 *     cosmetic sub-shapes (ui_state, geometry, rail metadata) pass through
 *     untouched — quarantining a window's content over a corrupt sidebar
 *     width would be worse than restoring it.
 *   - Written against `zod/mini`, the tree-shakable build of the same
 *     library: classic zod's chainable API brings the whole library along
 *     (~88 kB) into the startup bundle, this one only what these schemas use.
 *     Mini ships no messages, so the English locale is configured here and
 *     quarantine reasons read exactly as before.
 *
 * @coordinates-with sessionSalvage.ts — per-item salvage over these schemas
 * @coordinates-with instanceContextState.ts — opaque-field validation at restore
 * @module services/persistence/hotExit/sessionSchema
 */
import * as z from "zod/mini";

z.config(z.locales.en());

/** Cursor info is best-effort at restore; object-or-null is enough here. */
const cursorInfoSchema = z.union([z.looseObject({}), z.null()]);

/** History checkpoints are consumed defensively downstream; require object-ness. */
const historyCheckpointSchema = z.looseObject({});

/** Document content is the payload that must never be silently lost. */
const documentStateSchema = z.looseObject({
  content: z.string(),
  saved_content: z.string(),
  is_dirty: z.optional(z.boolean()),
  is_missing: z.optional(z.boolean()),
  is_divergent: z.optional(z.boolean()),
  is_read_only: z.optional(z.boolean()),
  line_ending: z.optional(z.enum(["\n", "\r\n", "unknown"])),
  cursor_info: z.optional(cursorInfoSchema),
  last_modified_timestamp: z.nullish(z.number()),
  is_untitled: z.optional(z.boolean()),
  untitled_number: z.nullish(z.number()),
  undo_history: z.optional(z.array(historyCheckpointSchema)),
  redo_history: z.optional(z.array(historyCheckpointSchema)),
  mode: z.optional(z.enum(["wysiwyg", "source"])),
  hard_break_style: z.optional(z.enum(["backslash", "twoSpaces", "mixed", "unknown"])),
  last_disk_content: z.optional(z.string()),
});

/** A restorable tab: identity + document integrity. v3 fields optional (pre-migration). */
export const tabStateSchema = z.looseObject({
  id: z.string(),
  file_path: z.nullish(z.string()),
  title: z.string(),
  is_pinned: z.optional(z.boolean()),
  document: documentStateSchema,
  format_id: z.optional(z.string()),
  editing_enabled: z.optional(z.boolean()),
  active_schema_id: z.nullish(z.string()),
});

/**
 * A window's routing envelope. Tabs are validated per-item by the salvage
 * layer (this schema only requires an array), so one corrupt tab never
 * quarantines its siblings.
 */
export const windowEnvelopeSchema = z.looseObject({
  window_label: z.string(),
  is_main_window: z.boolean(),
  active_tab_id: z.nullish(z.string()),
  tabs: z.array(z.unknown()),
});

/** The session envelope: identity fields migration/dispatch cannot proceed without. */
export const sessionEnvelopeSchema = z.looseObject({
  version: z.number(),
  timestamp: z.number(),
  vmark_version: z.string(),
  windows: z.array(z.unknown()),
});

/** Workspace payload: object-or-null; salvage replaces an invalid one with null. */
export const workspaceStateSchema = z.union([z.looseObject({}), z.null()]);

/**
 * Per-instance UI state (an opaque WindowState field). Mirrors the hydrate guard in
 * workspaceInstanceUiStore (`isValidInstanceUiState`) so the boundary is
 * exactly as strict as the store — plus passthrough for unknown fields.
 */
export const instanceUiStateSchema = z.looseObject({
  sidebarWidth: z.nullable(z.number()),
  sidebarViewMode: z.nullable(z.string()),
  fileExplorerOpenState: z.nullable(z.record(z.string(), z.unknown())),
  fileTreeScrollOffset: z.nullable(z.number()),
  outlineByTabId: z.record(z.string(), z.unknown()),
});

/** Opaque record payloads (closed_tab_scopes, ui_state_by_instance containers). */
export const opaqueRecordSchema = z.record(z.string(), z.unknown());

/** One human-readable line summarizing why a payload failed its schema. */
export function schemaReason(error: z.core.$ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}
