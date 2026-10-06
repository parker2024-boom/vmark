// WI-RA6.6 — spawnPty waits for the shell to be running. A spawn the backend
//   refuses (a shell VMark does not list) reaches the caller: the configured
//   shell falls back to the system default, and a refused default is an error
//   the terminal can show rather than a silent, dead session.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnPty } from "./spawnPty";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "get_default_shell") return Promise.resolve("/bin/zsh");
    if (cmd === "get_login_shell_path") return Promise.resolve("/usr/bin:/bin");
    return Promise.resolve(null);
  }),
}));
vi.mock("@/lib/pty", () => ({ spawn: vi.fn() }));

import { useSettingsStore } from "@/stores/settingsStore";
import { spawn } from "@/lib/pty";

const term = { cols: 80, rows: 24, write: vi.fn() } as unknown as import("@xterm/xterm").Terminal;

/** A PTY stand-in whose readiness the test controls. */
function fakePty(ready: Promise<void>) {
  // Mark handled: a rejection nobody awaits must fail the assertion that
  // expects it, not the whole run as an unhandled rejection.
  ready.catch(() => {});
  return { ready, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn() };
}

/** The real settings store: the shell under test, shell integration off. */
function configureShell(shell: string) {
  useSettingsStore.setState((state) => ({
    terminal: { ...state.terminal, shell, shellIntegration: false },
  }));
}

/** Make successive `spawn` calls return these stand-ins. */
function spawnReturns(...ptys: ReturnType<typeof fakePty>[]) {
  for (const pty of ptys) vi.mocked(spawn).mockReturnValueOnce(pty as unknown as ReturnType<typeof spawn>);
}

const initialTerminal = useSettingsStore.getState().terminal;

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ terminal: initialTerminal });
});

describe("spawnPty readiness", () => {
  it("falls back to the default shell when the backend refuses the configured one", async () => {
    configureShell("/opt/unlisted/fish");
    const refused = fakePty(Promise.reject(new Error("Not a shell VMark lists")));
    const fallback = fakePty(Promise.resolve());
    spawnReturns(refused, fallback);

    const pty = await spawnPty({ term, onExit: vi.fn(), disposed: () => false });

    expect(vi.mocked(spawn).mock.calls.map((call) => call[0])).toEqual(["/opt/unlisted/fish", "/bin/zsh"]);
    expect(pty).toBe(fallback);
  });

  it("rejects with the backend's error when the default shell is refused", async () => {
    configureShell("");
    spawnReturns(fakePty(Promise.reject(new Error("Not a shell VMark lists"))));

    await expect(spawnPty({ term, onExit: vi.fn(), disposed: () => false })).rejects.toThrow(
      "Not a shell VMark lists",
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects when the fallback shell is refused too", async () => {
    configureShell("/opt/unlisted/fish");
    spawnReturns(
      fakePty(Promise.reject(new Error("first refusal"))),
      fakePty(Promise.reject(new Error("second refusal"))),
    );

    await expect(spawnPty({ term, onExit: vi.fn(), disposed: () => false })).rejects.toThrow("second refusal");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("wires output and exit before the shell is ready, and resolves only once it is", async () => {
    configureShell("");
    let becomeReady: () => void = () => {};
    const pending = fakePty(new Promise<void>((resolve) => { becomeReady = resolve; }));
    spawnReturns(pending);
    const onExit = vi.fn();
    let settled = false;

    const spawning = spawnPty({ term, onExit, disposed: () => false }).then((pty) => {
      settled = true;
      return pty;
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    // The reader may emit the moment it starts, so both listeners must
    // already be in place while readiness is still pending.
    await vi.waitFor(() => expect(pending.onExit).toHaveBeenCalledTimes(1));
    expect(pending.onData).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    becomeReady();
    expect(await spawning).toBe(pending);

    const exitListener = pending.onExit.mock.calls[0][0] as (event: { exitCode: number }) => void;
    exitListener({ exitCode: 3 });
    expect(onExit).toHaveBeenCalledWith(3);
  });
});
