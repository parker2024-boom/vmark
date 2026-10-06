/**
 * Per-session ordered PTY input delivery.
 *
 * Purpose: asynchronous IPC and the backend blocking pool do not preserve the
 * order of concurrent writes. Keep one request in flight and batch input that
 * arrives while it completes, so keystrokes, IME commits and paste stay ordered.
 * Failed writes are not retried because they may already have written a prefix.
 * Closing the queue drops pending input without waiting for the current write.
 *
 * @coordinates-with lib/pty.ts — owns one queue per PTY and closes it on teardown
 * @module lib/ptyInputQueue
 */

/** Ordered input sink for one PTY session. */
export interface PtyInputQueue {
  /** Queue `data` for delivery after every earlier write; ignored once closed or empty. */
  write(data: string): void;
  /** Drop pending input and refuse further writes; an in-flight write is not awaited. */
  close(): void;
}

export function createPtyInputQueue(
  write: (data: string) => Promise<void>,
  onError: (error: unknown) => void,
): PtyInputQueue {
  let pending: string[] = [];
  let running = false;
  let closed = false;

  const drain = async () => {
    running = true;
    try {
      while (!closed && pending.length) {
        const data = pending.join("");
        pending = [];
        try {
          await write(data);
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    write(data: string): void {
      if (closed || !data) return;
      pending.push(data);
      if (!running) void drain();
    },
    close(): void {
      closed = true;
      pending = [];
    },
  };
}
