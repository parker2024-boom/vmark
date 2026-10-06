// @vitest-environment node
// WI-RA6.6 — a shell the backend refuses to spawn must be observable: `ready`
//   rejects with a readable Error instead of the failure staying inside the
//   wrapper, where a caller could not fall back or tell the user.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, listenMock, MockChannel } = vi.hoisted(() => {
  class MockChannel {
    onmessage: ((msg: unknown) => void) | null = null;
  }
  return { invokeMock: vi.fn(), listenMock: vi.fn(), MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: MockChannel,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));
vi.mock("@/utils/debug", () => ({ ptyWarn: vi.fn(), terminalLog: vi.fn() }));

// src/test/setup.ts mocks @/lib/pty for the Terminal component tests; this
// suite exercises the real wrapper.
vi.unmock("@/lib/pty");

import { spawn } from "@/lib/pty";

const PID = 77;
/** The shape a typed command rejection has on the wire. */
const refused = { code: "permission-denied", message: "Not a shell VMark lists: /tmp/evil" };

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => {});
});

describe("VMarkPty.ready", () => {
  it("resolves once the reader has been started", async () => {
    const calls: string[] = [];
    invokeMock.mockImplementation((cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(cmd === "pty_spawn" ? PID : undefined);
    });

    await spawn("/bin/zsh", []).ready;

    expect(calls).toEqual(["pty_spawn", "pty_start"]);
  });

  it("rejects with the backend's message when the spawn is refused", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "pty_spawn" ? Promise.reject(refused) : Promise.resolve(undefined),
    );

    const failure = await spawn("/tmp/evil", []).ready.then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Not a shell VMark lists: /tmp/evil");
    expect((failure as Error).cause).toBe(refused);
    // Nothing was created, so there is nothing to start or free.
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual(["pty_spawn"]);
  });

  it("rejects, and frees the session, when the reader cannot be started", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pty_spawn") return Promise.resolve(PID);
      if (cmd === "pty_start") return Promise.reject({ code: "internal", message: "no thread" });
      return Promise.resolve(undefined);
    });

    await expect(spawn("/bin/zsh", []).ready).rejects.toThrow("no thread");

    expect(invokeMock).toHaveBeenCalledWith("pty_kill", { pid: PID });
    expect(invokeMock).toHaveBeenCalledWith("pty_close", { pid: PID });
  });

  it("keeps kill() quiet after a refused spawn", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "pty_spawn" ? Promise.reject(refused) : Promise.resolve(undefined),
    );
    const pty = spawn("/tmp/evil", []);
    await pty.ready.catch(() => {});

    pty.kill();
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).not.toHaveBeenCalledWith("pty_kill", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("pty_close", expect.anything());
  });
});
