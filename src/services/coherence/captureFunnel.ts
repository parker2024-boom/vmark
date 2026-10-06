/**
 * Coherence capture funnel
 *
 * Purpose: the single frontend seam into the Rust coherence kernel —
 * write capture (`captureWrite`), live-buffer AI-edit capture
 * (`captureAiEdit`, no disk rewrite) and the explorer new-file helper. MCP
 * write capture with the session-observed read set lives in `mcpCapture.ts`
 * and funnels through `captureWrite`. Fire-and-forget by design: a failed capture logs and
 * returns null — it never fails the write it describes (the scan
 * reconciler heals any gap, spec §9.4).
 *
 * Key decisions:
 *   - All captures from one webview run strictly in submission order
 *     (module-level promise queue) so an older buffer can never become
 *     the newest revision.
 *   - Only files inside the open workspace are captured (traversal
 *     segments rejected here AND in the Rust path guard); the kernel
 *     owns coherence state per workspace root.
 *   - When the kernel rewrites the file to (re)insert the identity block,
 *     a pending save is registered with the rewritten content so the file
 *     watcher swallows the kernel's own write instead of prompting.
 *   - Every capture carries the capture-on-save policy read at entry
 *     (WI-LX1.4, `capturePolicy.ts`); the kernel enforces it and answers
 *     `null` when it declines — no `.vmark/`, no stamped file.
 *
 * @coordinates-with src-tauri/src/coherence/commands_ipc.rs — coherence_capture
 * @coordinates-with pendingSaves.ts — watcher echo suppression
 * @coordinates-with capturePolicy.ts — the capture-on-save setting on the wire
 * @module services/coherence/captureFunnel
 */
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "@/stores/documentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { registerPendingSave, clearPendingSaveAfterGrace } from "@/utils/pendingSaves";
import { coherenceLog } from "@/utils/debug";
import { currentCapturePolicy } from "./capturePolicy";

/**
 * One capture input on the way to the Rust side. Serialized as JSON, where a
 * key holding `undefined` and a missing key are the same wire bytes — so the
 * fields are `| undefined` rather than forcing every producer to reshape the
 * object around whichever facts it happens to know.
 */
export interface CoherenceCaptureInput {
  path?: string | undefined;
  object_id?: string | undefined;
  revision?: string | undefined;
  role: "direct" | "contextual";
}

export interface CaptureAiEditArgs {
  tabId: string;
  modelId?: string;
  intentKind: string;
  summary: string;
  /** Buffer had uncaptured human edits when the AI ran (read BEFORE the
   *  apply) — the true input state is then no ledger revision (spec §8). */
  bufferWasDirty: boolean;
}

export interface CaptureWriteArgs {
  /** Absolute path of the file that was written. */
  absolutePath: string;
  /** The exact content written (plan contract — no disk re-read). */
  content: string;
  inputs?: CoherenceCaptureInput[];
  /** Inputs that are still being resolved (MCP read pins). The capture takes
   *  its place in the queue NOW and waits for these inside it, so a capture
   *  issued later can never be recorded first. Replaces `inputs` when set. */
  pendingInputs?: Promise<CoherenceCaptureInput[]>;
  agent: { type: "human" | "model" | "external"; id?: string | undefined };
  intent: { kind: string; summary: string };
  /** Defaults to "exact" (in-app paths); MCP writes pass "inferred". */
  confidence?: "exact" | "inferred";
  /** False = record the revision without rewriting the file's identity
   *  block on disk (empty explorer-created files; live buffers). */
  rewriteIdentity?: boolean;
}

export interface CoherenceCaptureReceipt {
  object: string;
  revision: string;
  entry_id: string | null;
  content_with_identity: string | null;
}

// All captures from this webview run strictly in submission order:
// overlapping saves/applies must not reach the kernel out of order,
// or an older buffer could become the newest revision.
let captureQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = captureQueue.then(op, op);
  captureQueue = next.catch(() => {});
  return next;
}

/**
 * Workspace-relative path with prefix-boundary safety: `/ws/storyboard`
 * is not inside `/ws/story`. Returns null for files outside the root.
 */
export function workspaceRelativePath(root: string, absolutePath: string): string | null {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  if (!absolutePath.startsWith(normalizedRoot + "/")) return null;
  const rel = absolutePath.slice(normalizedRoot.length + 1);
  if (rel.length === 0 || rel.includes("\\")) return null;
  // Traversal segments never survive to the IPC boundary (the Rust guard
  // rejects them too — this is defense in depth).
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return rel;
}

/** Capture one successful write. Never throws; null = not captured
 *  (outside the workspace, declined by the capture-on-save policy, or failed).
 *  Serialized per webview; a caller-minted idem survives
 *  retries (spec §5.1). */
export async function captureWrite(
  args: CaptureWriteArgs
): Promise<CoherenceCaptureReceipt | null> {
  try {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return null;
    const rel = workspaceRelativePath(root, args.absolutePath);
    if (!rel) return null;
    const idem = crypto.randomUUID();
    const policy = currentCapturePolicy();
    return await enqueue(async () => {
      const inputs = args.pendingInputs ? await args.pendingInputs : (args.inputs ?? []);
      const receipt = await invoke<CoherenceCaptureReceipt | null>("coherence_capture", {
        workspaceRoot: root,
        request: {
          path: rel,
          content: args.content,
          inputs,
          agent: args.agent,
          intent: args.intent,
          confidence: args.confidence ?? "exact",
          rewrite_identity: args.rewriteIdentity ?? true,
          idem,
        },
        policy,
      });
      if (receipt?.content_with_identity) {
        // The kernel rewrote the file on disk; let the watcher match it.
        const token = registerPendingSave(args.absolutePath, receipt.content_with_identity);
        clearPendingSaveAfterGrace(args.absolutePath, token);
      }
      return receipt;
    });
  } catch (error) {
    coherenceLog("capture failed (write unaffected):", error);
    return null;
  }
}

/**
 * Capture an AI edit applied to a live editor buffer (genie auto-apply or
 * suggestion accept). The kernel records the buffer revision WITHOUT
 * touching the file on disk (`rewrite_identity: false`); the next real
 * save is then a no-op capture unless the human edited further.
 *
 * Only the snapshot is specific to this path; the queue, idempotency key,
 * policy and IPC are `captureWrite`'s, so the two contracts cannot drift.
 */
export async function captureAiEdit(
  args: CaptureAiEditArgs
): Promise<CoherenceCaptureReceipt | null> {
  // Snapshot NOW: the store is read synchronously at the
  // apply site's call, so a rapid second apply or tab switch cannot
  // change what this capture records.
  const doc = useDocumentStore.getState().getDocument(args.tabId);
  if (!doc?.filePath) return null; // untitled — adopted at first save
  const root = useWorkspaceStore.getState().rootPath;
  if (!root) return null;
  const rel = workspaceRelativePath(root, doc.filePath);
  if (!rel) return null;
  return captureWrite({
    absolutePath: doc.filePath,
    content: doc.content,
    inputs: [{ path: rel, role: "direct" }],
    agent: { type: "model", id: args.modelId },
    intent: { kind: args.intentKind, summary: args.summary },
    confidence: args.bufferWasDirty ? "inferred" : "exact",
    rewriteIdentity: false,
  });
}

/**
 * One-line funnel for explorer-created files: registers the
 * object from birth without rewriting the fresh empty file — identity
 * lands with the first real save. Fire-and-forget.
 */
export function captureExplorerNewFile(absolutePath: string): void {
  void captureWrite({
    absolutePath,
    content: "",
    agent: { type: "human" },
    intent: { kind: "explorer-new-file", summary: "new file" },
    rewriteIdentity: false,
  }).catch(() => {});
}
