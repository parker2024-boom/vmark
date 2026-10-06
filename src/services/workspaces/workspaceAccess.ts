/**
 * workspaceAccess — the frontend half of Rust-owned workspace grants (WI-LX1.1).
 *
 * Purpose: a folder outside the static fs scope (`$HOME/**`, `/Volumes/**`,
 *   `/mnt/**`, `/media/**`, and `C:\` to `F:\` on Windows) is readable only
 *   through a RUNTIME grant, and Rust makes that grant only for a folder it can
 *   attribute to the user: one picked in the folder dialog Rust shows, one
 *   opened from Finder, or one recorded from those in an earlier session. This
 *   module asks about a folder and turns the answer into what the caller should
 *   do; it cannot make Rust grant anything.
 *
 * Key decisions:
 *   - Rust answers only "was this chosen before?". Whether the static scope
 *     already reads the folder is MEASURED with one `exists()` probe, never
 *     modelled here: the capability globs (and their dot-file rule) are the
 *     fs plugin's to evaluate, and a hand copy would drift. The probe has
 *     three answers, not two: it reads the folder, finds it gone, or is
 *     refused by the scope ("forbidden path" — the fs plugin's only signal,
 *     pinned by `fs_scope.test.rs`). Any other failure answers nothing.
 *   - Anything that is not a clean typed answer is `unverified`, never read as
 *     permission. Callers decide how to degrade. The same goes for the
 *     picker: only `null` is a cancel.
 *   - Confirming a folder is the picker, opened AT that folder, so it is one
 *     click on Open. `requestWorkspaceConfirmation` does not wait for the
 *     user — the MCP transport cannot hold a request open for a person — but
 *     it does wait for Rust to say the dialog is SHOWN, so the caller can tell
 *     that from "another dialog is open" and from a failure.
 *
 * @coordinates-with src-tauri/src/workspace/grants/commands.rs — allow_workspace_access
 * @coordinates-with src-tauri/src/workspace/grants/picker.rs — pick_workspace_folder, request_workspace_confirmation
 * @coordinates-with contexts/WindowContext.tsx — a startup workspace waits for its grant
 * @coordinates-with services/persistence/resilience/_hotExitRestore.ts — so do restored ones
 * @coordinates-with services/commands/workspaceCommands.ts — File → Open Workspace (the picker)
 * @coordinates-with services/commands/recentWorkspacesCommands.ts — Open Recent
 * @coordinates-with services/mcpBridge/v2/workspaceOpenFolder.ts — the open_workspace tool
 * @module services/workspaces/workspaceAccess
 */
import { invoke } from "@tauri-apps/api/core";
import { exists } from "@tauri-apps/plugin-fs";
import { parseCommandError } from "@/services/commands/commandError";
import { workspaceError, workspaceWarn } from "@/utils/debug";

/** What the caller may do with a folder it wants to open as a workspace. */
export type WorkspaceAccess =
  /** Chosen before (or inside a chosen folder): granted again. */
  | { kind: "granted"; root: string }
  /** Not chosen, but the static scope already reads it — nothing to grant. */
  | { kind: "readable" }
  /** Gone, or not a folder. */
  | { kind: "missing" }
  /** Not chosen and unreadable: only the user, in the picker, can grant it. */
  | { kind: "needs-confirmation" }
  /** No usable answer (IPC failure, unexpected code, malformed reply). */
  | { kind: "unverified"; error: unknown };

/** What one `exists()` probe says about reading `path` without a grant. */
export type ProbeWithoutGrant =
  | { kind: "readable" }
  | { kind: "missing" }
  /** The fs plugin refused the path: outside every scope. */
  | { kind: "out-of-scope" }
  /** The probe itself failed; it says nothing about the scope. */
  | { kind: "failed"; error: unknown };

/** The fs plugin's scope refusal: a bare "forbidden path: …" string. */
function isScopeRefusal(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return message.startsWith("forbidden path");
}

/** Can the webview read `path` without a runtime grant? One probe decides. */
export async function probeWithoutGrant(path: string): Promise<ProbeWithoutGrant> {
  try {
    return (await exists(path)) ? { kind: "readable" } : { kind: "missing" };
  } catch (error) {
    return isScopeRefusal(error) ? { kind: "out-of-scope" } : { kind: "failed", error };
  }
}

/** Ask Rust about `path` and turn the answer into a {@link WorkspaceAccess}. */
export async function resolveWorkspaceAccess(path: string): Promise<WorkspaceAccess> {
  let root: unknown;
  try {
    root = await invoke<string>("allow_workspace_access", { path });
  } catch (error) {
    const code = parseCommandError(error)?.code;
    if (code === "not-found" || code === "invalid-input") return { kind: "missing" };
    if (code !== "permission-denied") return { kind: "unverified", error };
    const probe = await probeWithoutGrant(path);
    switch (probe.kind) {
      case "readable":
      case "missing":
        return { kind: probe.kind };
      case "out-of-scope":
        return { kind: "needs-confirmation" };
      case "failed":
        return { kind: "unverified", error: probe.error };
    }
  }
  if (typeof root !== "string" || root.length === 0) {
    return { kind: "unverified", error: new Error("allow_workspace_access returned no root") };
  }
  return { kind: "granted", root };
}

/**
 * Show the folder picker Rust owns; Rust grants and records what the user
 * picks. Resolves to the canonical folder, or `null` when cancelled. Rejects
 * when a picker is already open (`conflict`), the IPC fails, or the answer is
 * neither a folder nor `null`.
 */
export async function pickWorkspaceFolder(
  options: { defaultPath?: string } = {},
): Promise<string | null> {
  const picked: unknown = await invoke<string | null>("pick_workspace_folder", {
    defaultPath: options.defaultPath ?? null,
  });
  if (picked === null) return null;
  if (typeof picked === "string" && picked.length > 0) return picked;
  throw new Error(`pick_workspace_folder returned a malformed answer: ${JSON.stringify(picked)}`);
}

/** What asking the user to confirm a folder came to. */
export type ConfirmationRequest =
  | { kind: "opened" }
  /** Another folder dialog is open; this one was not shown. */
  | { kind: "busy" }
  | { kind: "failed"; error: unknown };

/**
 * Ask the user to confirm `path` in the picker, opened at it. Resolves once
 * the dialog is on screen, without waiting for the user; Rust grants and
 * records the folder if they choose it. Never throws.
 */
export async function requestWorkspaceConfirmation(path: string): Promise<ConfirmationRequest> {
  try {
    await invoke("request_workspace_confirmation", { path });
    return { kind: "opened" };
  } catch (error) {
    if (parseCommandError(error)?.code === "conflict") {
      workspaceWarn("A folder dialog is already open; not opening another for", path);
      return { kind: "busy" };
    }
    workspaceError("Could not open the folder dialog:", error);
    return { kind: "failed", error };
  }
}

/**
 * Re-issue the grant for `path` if the user chose it before. Never throws: a
 * refusal is the ordinary answer for a folder the static scope covers, and any
 * other failure leaves the open to surface its own read errors.
 */
export async function regrantWorkspaceAccess(path: string): Promise<void> {
  try {
    await invoke<string>("allow_workspace_access", { path });
  } catch (error) {
    if (parseCommandError(error)?.code !== "permission-denied") {
      workspaceError("Could not re-grant workspace access:", error);
    }
  }
}

/**
 * Re-issue the grant for each distinct root and wait for the answers — at most
 * `waitMs`. One at a time: Rust bounds concurrent checks, and a root already
 * granted at launch answers in microseconds. The bound is for a DEAD mount,
 * whose check can hold for minutes; past it the caller goes on, and the grant
 * still lands whenever Rust gets its answer. Never throws.
 */
export async function awaitWorkspaceGrants(
  roots: Iterable<string>,
  waitMs: number,
): Promise<void> {
  const unique = [...new Set(roots)];
  if (unique.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const all = (async () => {
    for (const root of unique) await regrantWorkspaceAccess(root);
  })();
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  await Promise.race([all, bound]);
  clearTimeout(timer);
}
