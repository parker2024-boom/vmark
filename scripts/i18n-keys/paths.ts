/**
 * The repository root every i18n check resolves its locale and source paths against.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate CLI that runs this check
 * @module scripts/i18n-keys/paths
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: two levels above this module (scripts/i18n-keys/). */
export const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
