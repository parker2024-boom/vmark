/**
 * The mocked Tauri surface for the bridge disk suites, plus a gate that can
 * hold application writes in flight.
 *
 * A LEAF module on purpose: it imports the stateful disk fake and nothing from
 * the app. A `vi.mock` factory is awaited while the mocked module is being
 * resolved, so a factory that imports anything which itself imports
 * `@tauri-apps/*` waits on its own result and the suite hangs at collection.
 *
 * @coordinates-with bridgeDiskHarness.ts — store reset and reply capture
 * @coordinates-with test/statefulFsFake.ts — the disk
 * @module services/mcpBridge/v2/__tests__/bridgeWriteGate
 */
import { statefulFs } from "@/test/statefulFsFake";

/** Effects to run while an existence probe of a path is in flight. */
const existsProbeEffects = new Map<string, () => void>();

/**
 * Holds application writes to chosen paths until the test releases them, so a
 * test can observe what is (and is not) in flight at the same time.
 */
class WriteGate {
  private held = new Map<string, Array<() => void>>();

  /** Make every later write to `path` wait at the gate. */
  hold(path: string): void {
    if (!this.held.has(path)) this.held.set(path, []);
  }

  /** How many writes to `path` are waiting right now. */
  waitingAt(path: string): number {
    return this.held.get(path)?.length ?? 0;
  }

  /** Let the oldest waiting write to `path` through. */
  releaseOne(path: string): void {
    const next = this.held.get(path)?.shift();
    if (!next) throw new Error(`bridgeWriteGate: no write is waiting at ${path}`);
    next();
  }

  /** Stop holding `path` and let everything waiting there through. */
  open(path: string): void {
    const waiting = this.held.get(path) ?? [];
    this.held.delete(path);
    for (const release of waiting) release();
  }

  reset(): void {
    for (const path of [...this.held.keys()]) this.open(path);
    existsProbeEffects.clear();
  }

  pass(path: string): Promise<void> {
    const waiting = this.held.get(path);
    if (!waiting) return Promise.resolve();
    return new Promise((resolve) => waiting.push(resolve));
  }
}

export const writeGate = new WriteGate();

/**
 * Run `effect` the next time the app asks whether `path` exists, while that
 * probe is in flight — for what can happen to the app during an await.
 */
export function duringExistsProbe(path: string, effect: () => void): void {
  existsProbeEffects.set(path, effect);
}

type FsWrite = (path: string, contents: string, options?: unknown) => Promise<void>;
type FsExists = (path: string) => Promise<boolean>;

/** `@tauri-apps/plugin-fs` over the stateful disk, with writes passing the gate. */
export function gatedFsModule(): Record<string, unknown> {
  const real = statefulFs.fsModule();
  const gatedWrite: FsWrite = async (path, contents, options) => {
    await writeGate.pass(path);
    return (real.writeTextFile as FsWrite)(path, contents, options);
  };
  const probedExists: FsExists = (path) => {
    const effect = existsProbeEffects.get(path);
    existsProbeEffects.delete(path);
    effect?.();
    return (real.exists as FsExists)(path);
  };
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "writeTextFile") return gatedWrite;
      if (prop === "exists") return probedExists;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** `@tauri-apps/api/core` over the stateful disk, with atomic writes passing the gate. */
export function gatedCoreModule(): {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    invoke: async (cmd, args) => {
      if (cmd === "atomic_write_file") await writeGate.pass(String(args?.path));
      return statefulFs.invoke(cmd, args);
    },
  };
}
