// Regression cover for the wait that stands between the sidecar's MCP
// handshake and a journey's first tool call.
//
// The case that matters is `waits through "Not connected to VMark"`: that reply
// is exactly what journeys 33 and 34 got as their FIRST call in run
// 37419115196, ~1.2s after a handshake that had already succeeded. The
// sidecar serves stdio before it dials VMark (server/mcp/src/cli.ts), so a
// completed handshake proves nothing about the bridge.

import { describe, it, expect } from "vitest";
import { NOT_CONNECTED, awaitSidecarBridge } from "./sidecarBridge.mjs";

const notConnected = { isError: true, text: `Error: ${NOT_CONNECTED}` };
const connected = { isError: false, text: '{"windows":[]}' };

/** A fake clock: `sleep` advances time instead of waiting. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

/** A probe that replays `replies` in order, then repeats the last one. */
function scripted(replies) {
  const calls = [];
  const probe = async (name, args) => {
    calls.push({ name, args });
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  };
  return { probe, calls };
}

describe("awaitSidecarBridge", () => {
  it("returns at once when the bridge is already up", async () => {
    const { probe, calls } = scripted([connected]);
    await awaitSidecarBridge(probe, fakeClock());
    expect(calls).toEqual([{ name: "session", args: { action: "get_state" } }]);
  });

  it('waits through "Not connected to VMark" until the bridge answers', async () => {
    const { probe, calls } = scripted([notConnected, notConnected, connected]);
    await awaitSidecarBridge(probe, fakeClock());
    expect(calls).toHaveLength(3);
  });

  it("treats any other refusal as a live bridge — only the transport error waits", async () => {
    // An app-level refusal travelled sidecar → VMark → sidecar, so the bridge is up.
    const { probe, calls } = scripted([{ isError: true, text: "NEEDS_APPROVAL: …" }]);
    await awaitSidecarBridge(probe, fakeClock());
    expect(calls).toHaveLength(1);
  });

  it("fails loudly, naming the last reply, when the bridge never connects", async () => {
    const { probe } = scripted([notConnected]);
    await expect(awaitSidecarBridge(probe, { ...fakeClock(), timeoutMs: 1000 })).rejects.toThrow(
      /did not connect to VMark within 1000ms.*Not connected to VMark/s,
    );
  });

  it("propagates a probe that throws instead of retrying it", async () => {
    const probe = async () => {
      throw new Error("sidecar exited");
    };
    await expect(awaitSidecarBridge(probe, fakeClock())).rejects.toThrow("sidecar exited");
  });
});
