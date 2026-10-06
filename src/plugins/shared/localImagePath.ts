/**
 * Local Image Path Access
 *
 * Purpose: The two filesystem questions an image-path paste asks — where does
 * `~/` point, and does this file exist — answered through Tauri, for both
 * editor modes.
 *
 * Key decisions:
 *   - Neither function throws: a failed lookup is an answer (null / false),
 *     and callers fall back to pasting the text.
 *
 * @coordinates-with plugins/shared/imagePasteResolve.ts — the paste flow that asks
 * @module plugins/shared/localImagePath
 */

import { exists } from "@tauri-apps/plugin-fs";
import { homeDir, join } from "@tauri-apps/api/path";

/**
 * Expand a home path (`~/…`) to an absolute path. Other paths are returned
 * unchanged; null means the home directory could not be resolved.
 */
export async function expandHomePath(path: string): Promise<string | null> {
  if (!path.startsWith("~/")) return path;

  try {
    const home = await homeDir();
    return await join(home, path.slice(2));
  } catch {
    return null;
  }
}

/** Whether a local path exists. A failed check counts as "does not exist". */
export async function validateLocalPath(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    return false;
  }
}
