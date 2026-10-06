// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class { onmessage: unknown; },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/utils/debug", () => ({ ptyWarn: vi.fn(), terminalLog: vi.fn() }));
vi.unmock("@/lib/pty");
import { spawn } from "./pty";

interface PendingWrite { data: string; resolve: () => void; reject: (error: Error) => void }
let pending: PendingWrite[];
let delivered: string[];
beforeEach(() => {
  pending = [];
  delivered = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string, args: { data: string }) => {
    if (cmd === "pty_spawn") return Promise.resolve(42);
    if (cmd !== "pty_write") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      pending.push({ data: args.data, resolve: () => { delivered.push(args.data); resolve(); }, reject });
    });
  });
});
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function drain() {
  await tick();
  while (pending.length) {
    expect(pending).toHaveLength(1);
    pending.shift()!.resolve();
    await tick();
  }
}

describe("PTY input order", () => {
  it("keeps a rapid mixed Unicode burst and Enter in order with only one write in flight", async () => {
    const pty = spawn("/bin/bash", []);
    await pty.ready;
    pty.write("p");
    await tick();
    const rest = "rintf '你好🙂 é مرحبا'\r";
    for (const char of rest) pty.write(char);
    await tick();
    expect(pending).toHaveLength(1);
    await drain();
    expect(delivered.join("")).toBe("p" + rest);
    // Buffered keystrokes should not cost one IPC round trip each.
    expect(delivered.length).toBeLessThan(5);
  });

  it("preserves bracketed paste, control bytes and following input", async () => {
    const pty = spawn("/bin/bash", []);
    await pty.ready;
    const chunks = ["\x1b[200~" + "中文abc\n".repeat(10000), "\x1b[201~", "\x7f", "\x03", "next\r"];
    for (const chunk of chunks) pty.write(chunk);
    await drain();
    expect(delivered.join("")).toBe(chunks.join(""));
  });

  it("drops queued input when the session is killed during a write", async () => {
    const pty = spawn("/bin/bash", []);
    await pty.ready;
    pty.write("first");
    await tick();
    pty.write("must not run");
    pty.kill();
    await drain();
    expect(delivered).toEqual(["first"]);
  });

  it("does not replay a failed partial write and can accept later input", async () => {
    const pty = spawn("/bin/bash", []);
    await pty.ready;
    pty.write("failed");
    await tick();
    pending.shift()!.reject(new Error("PTY write failed"));
    await tick();
    pty.write("next");
    await drain();
    expect(delivered).toEqual(["next"]);
  });

  it("ignores empty writes", async () => {
    const pty = spawn("/bin/bash", []);
    await pty.ready;
    pty.write("");
    await tick();
    expect(pending).toEqual([]);
  });
});
