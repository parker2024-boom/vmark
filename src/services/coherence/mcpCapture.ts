/**
 * MCP write capture (split from captureFunnel.ts)
 *
 * Purpose: documents an external MCP client read since its last write become
 * the (inferred) input set of that write (spec §7 example 2). `recordMcpRead`
 * notes each read and pins the revision served at read time via
 * `coherence_head`; `captureMcpWrite` consumes the set and funnels the write
 * through `captureWrite`, so it carries the capture-on-save policy like every
 * other write path (WI-LX1.4).
 *
 * Key decisions:
 *   - Session reads are bounded (256, least-recent evicted). A write DETACHES
 *     the whole set synchronously at entry and awaits only that batch's pins
 *     (bounded 500 ms), so a read arriving mid-wait belongs to the next write
 *     and concurrent writes never share a read.
 *   - Each read is its own entry with a generation; a pin writes only into the
 *     generation it was issued for, so a late or out-of-order answer can never
 *     overwrite a newer read. At most one pin per entry is in flight (a re-read
 *     coalesces) and at most 256 overall — beyond that a read stays unpinned.
 *   - Each read remembers the workspace root it was served under; a write
 *     under a different root drops it (its revision belongs to another ledger).
 *   - A pin is PROVEN by content (`head_pin.rs`): it sends the
 *     content served, plus the tab's saved content when the buffer was dirty,
 *     and the kernel pins the latest revision on the head's history matching
 *     either. A read matching neither is left OUT of the inputs — leaving it
 *     unpinned would let the kernel resolve it to the head at write time, a
 *     revision the client never saw.
 *   - A write takes its place in the capture queue synchronously and awaits
 *     its pins INSIDE that slot (`pendingInputs`), so a later write or in-app
 *     save can never be recorded ahead of it.
 *
 * @coordinates-with captureFunnel.ts — `captureWrite`, the one IPC seam
 * @coordinates-with src-tauri/src/coherence/head_pin.rs — how coherence_head proves a pin
 * @module services/coherence/mcpCapture
 */
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "@/stores/documentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { coherenceLog } from "@/utils/debug";
import {
  captureWrite,
  workspaceRelativePath,
  type CoherenceCaptureInput,
  type CoherenceCaptureReceipt,
} from "./captureFunnel";

// ── MCP session-read tracking (spec §7 example 2) ───────────────
// Documents an external MCP client read since its last write become the
// (inferred) input set of that write. Module-level state is correct here:
// one webview = one bridge session. Bounded: a read-only
// client cannot grow this without limit.
const MAX_SESSION_READS = 256;
/** Hard cap on `coherence_head` calls in flight across all paths. */
const MAX_PINS_IN_FLIGHT = MAX_SESSION_READS;
/** How long a write waits for its reads' pins before capturing unpinned. */
const PIN_WAIT_MS = 500;

/**
 * One read the client received. An entry is replaced — never reused — when
 * the same path is read again, and is detached (removed from the map) by the
 * write that consumes it, so a pin can only ever write into the read it was
 * issued for.
 */
interface SessionRead {
  /** Workspace root at read time; the pin and `rel` are relative to it. */
  root: string;
  rel: string;
  /** Bumped by a re-read while this entry's pin is in flight. */
  generation: number;
  revision: string | undefined;
  /** The kernel knows the object but no revision matches what was served (or
   *  its saved base): the read is left out rather than resolved to a head the
   *  client never saw. */
  unprovable: boolean;
  /** The content the client was served by the latest read, if known. */
  content: string | undefined;
  /** The saved content an unsaved (dirty) served buffer was edited from. */
  baseContent: string | undefined;
  /** The in-flight `coherence_head` for this entry, if any. */
  pin: Promise<void> | null;
}

const sessionReads = new Map<string, SessionRead>();
let pinsInFlight = 0;

/** Issue (at most one) revision pin for `entry`'s current generation. A pin
 *  whose answer arrives for a superseded generation is discarded and one
 *  fresh pin follows, so at most one call per entry is ever in flight. */
function startPin(entry: SessionRead): void {
  if (entry.pin || pinsInFlight >= MAX_PINS_IN_FLIGHT) return; // over cap: stays unpinned
  pinsInFlight += 1;
  const generation = entry.generation;
  entry.pin = invoke<{ object: string; revision: string | null } | null>("coherence_head", {
    workspaceRoot: entry.root,
    path: entry.rel,
    content: entry.content,
    baseContent: entry.baseContent,
  })
    .then((head) => {
      if (!head || entry.generation !== generation) return;
      entry.revision = head.revision ?? undefined;
      entry.unprovable = head.revision === null;
    })
    .catch(() => {}) // pinning is best-effort; unpinned reads still count
    .finally(() => {
      pinsInFlight -= 1;
      entry.pin = null;
      if (entry.generation !== generation) startPin(entry);
    });
}

/** Record a document read served to the MCP client (absolute path).
 *  Pins the coherence revision served at READ time so a later
 *  upstream edit is never misattributed as this write's input. `content` is
 *  what was served and `tabId` the tab it came from, whose saved content is
 *  the base of an unsaved buffer. A read made outside the open workspace is
 *  not recorded — it could never be an input. */
export function recordMcpRead(absolutePath: string, content?: string, tabId?: string): void {
  const root = useWorkspaceStore.getState().rootPath;
  const rel = root ? workspaceRelativePath(root, absolutePath) : null;
  const existing = sessionReads.get(absolutePath);
  sessionReads.delete(absolutePath); // a re-read counts as the most recent
  if (!root || !rel) return;
  if (sessionReads.size >= MAX_SESSION_READS) {
    const oldest = sessionReads.keys().next().value;
    if (oldest !== undefined) sessionReads.delete(oldest);
  }
  const saved = tabId ? useDocumentStore.getState().documents[tabId]?.savedContent : undefined;
  const baseContent = saved !== undefined && saved !== content ? saved : undefined;
  let entry: SessionRead;
  if (existing && existing.root === root) {
    // Same read target: supersede in place so an in-flight pin coalesces.
    entry = existing;
    entry.generation += 1;
    entry.revision = undefined;
    entry.unprovable = false;
    entry.content = content;
    entry.baseContent = baseContent;
  } else {
    entry = {
      root,
      rel,
      generation: 0,
      revision: undefined,
      unprovable: false,
      content,
      baseContent,
      pin: null,
    };
  }
  sessionReads.set(absolutePath, entry);
  startPin(entry);
}

/** Detach every recorded read at once: reads arriving later belong to the
 *  NEXT write, and two concurrent writes can never consume the same read. */
function detachReads(): SessionRead[] {
  const batch = [...sessionReads.values()];
  sessionReads.clear();
  return batch;
}

/** Wait (bounded) for this batch's pins — including a re-pin a superseded
 *  answer triggered. */
async function awaitBatchPins(batch: SessionRead[]): Promise<void> {
  const deadline = Date.now() + PIN_WAIT_MS;
  for (;;) {
    const pins = batch.flatMap((e) => (e.pin ? [e.pin] : []));
    const remaining = deadline - Date.now();
    if (pins.length === 0 || remaining <= 0) return;
    await Promise.race([
      Promise.allSettled(pins),
      new Promise((resolve) => setTimeout(resolve, remaining)),
    ]);
  }
}

/** The batch's reads made under `root`, as capture inputs. A read served
 *  under another workspace root carries a revision of ANOTHER ledger, so it
 *  is dropped rather than re-rooted. */
function toInputs(batch: SessionRead[], root: string): CoherenceCaptureInput[] {
  return batch
    .filter((e) => e.root === root && !e.unprovable)
    .map((e) => ({ path: e.rel, revision: e.revision, role: "direct" as const }));
}

/** Consume the session-read set as capture inputs for an MCP write. */
export function takeMcpReadInputs(root: string): CoherenceCaptureInput[] {
  return toInputs(detachReads(), root);
}

/**
 * Capture an MCP bridge write (document.write / workspace.save). Always
 * `inferred` — the external agent's true context is unobservable (G1
 * finding 2); the session-observed read set is an honest under-
 * approximation.
 */
export async function captureMcpWrite(args: {
  absolutePath: string;
  content: string;
  toolName: string;
}): Promise<CoherenceCaptureReceipt | null> {
  try {
    const batch = detachReads(); // synchronously, before any await
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return null;
    // The written doc itself is the transformation target, not an input.
    const target = workspaceRelativePath(root, args.absolutePath);
    const pendingInputs = awaitBatchPins(batch).then(() =>
      toInputs(batch, root).filter((i) => i.path !== target)
    );
    // Called with no await before it, so the capture takes its queue slot NOW:
    // a later write (or an in-app save) cannot be recorded ahead of this one
    // while it waits for its pins.
    return await captureWrite({
      absolutePath: args.absolutePath,
      content: args.content,
      pendingInputs,
      agent: { type: "model", id: "mcp-client" },
      intent: { kind: "mcp-document-write", summary: args.toolName },
      confidence: "inferred",
    });
  } catch (error) {
    coherenceLog("MCP capture failed (write unaffected):", error);
    return null;
  }
}
