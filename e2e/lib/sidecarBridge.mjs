/**
 * What "the sidecar is drivable" MEANS — its bridge to VMark is connected, not
 * merely its MCP handshake complete.
 *
 * The same defect `readiness.mjs` records for the app, one process over. The
 * sidecar serves stdio FIRST and dials VMark concurrently (`server/mcp/src/
 * cli.ts`), deliberately, so an unreachable editor cannot time out the client's
 * `initialize`. So a completed handshake proves the stdio layer is up and says
 * nothing about the bridge. A journey whose first call outruns the dial gets
 * the sidecar's transport error, `Not connected to VMark`: journeys 33 and 34
 * did exactly that ~1.2s in on run 37419115196, on a slow macOS runner, while
 * the same journeys passed on the previous run.
 *
 * The probe is `session get_state`: read-only, approval-free, and already the
 * first call several journeys make. Only the transport error means "wait". Any
 * other reply — including an app-level refusal — crossed the bridge both ways,
 * which is the property being waited for.
 *
 * @coordinates-with server/mcp/src/cli.ts — serves stdio before the bridge dial
 * @coordinates-with server/mcp/src/bridge/websocket.ts — throws NOT_CONNECTED
 * @module e2e/lib/sidecarBridge
 */

/** The sidecar's transport error, verbatim from `websocket.ts`. */
export const NOT_CONNECTED = "Not connected to VMark";

/**
 * Covers the sidecar's reconnect schedule — first retry at 2s, backing off —
 * several times over on a loaded runner. A liveness bound, not a budget.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

/**
 * Resolve once a probe call has crossed the sidecar's bridge.
 *
 * @param {(name: string, args: object) => Promise<{isError: boolean, text: string}>} callTool
 * @param {{timeoutMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>}} [opts]
 */
export async function awaitSidecarBridge(callTool, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const deadline = now() + timeoutMs;
  for (;;) {
    const reply = await callTool("session", { action: "get_state" });
    if (!(reply.isError && reply.text.includes(NOT_CONNECTED))) return;
    if (now() >= deadline) {
      throw new Error(
        `the sidecar did not connect to VMark within ${timeoutMs}ms; last reply: ${reply.text.slice(0, 200)}`,
      );
    }
    await sleep(POLL_MS);
  }
}
