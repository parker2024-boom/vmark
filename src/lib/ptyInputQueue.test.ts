// @vitest-environment node
// Drives createPtyInputQueue directly (#1507): a rejected write must not strand
// input queued behind it, and close() must stop every later delivery — queued
// input, input written after close, and input queued while a write is in flight.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPtyInputQueue } from "./ptyInputQueue";

interface InFlight { data: string; resolve: () => void; reject: (error: Error) => void }
let inFlight: InFlight[];
let received: string[];
let writeFn: (data: string) => Promise<void>;
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

beforeEach(() => {
  inFlight = [];
  received = [];
  onError = vi.fn<(error: unknown) => void>();
  writeFn = (data) => {
    received.push(data);
    return new Promise<void>((resolve, reject) => inFlight.push({ data, resolve, reject }));
  };
});

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("createPtyInputQueue", () => {
  it("delivers a batch queued behind a rejected write without another keystroke", async () => {
    const queue = createPtyInputQueue(writeFn, onError);
    queue.write("first");
    await tick();
    queue.write("sec");
    queue.write("ond");
    expect(received).toEqual(["first"]);

    const error = new Error("PTY write failed");
    inFlight.shift()!.reject(error);
    await tick();

    expect(onError).toHaveBeenCalledWith(error);
    // The failed write is not replayed; the queued batch goes out on its own.
    expect(received).toEqual(["first", "second"]);
    inFlight.shift()!.resolve();
    await tick();
    expect(received).toEqual(["first", "second"]);
    expect(inFlight).toEqual([]);
  });

  it("delivers nothing written after close()", async () => {
    const queue = createPtyInputQueue(writeFn, onError);
    queue.close();
    queue.write("late");
    await tick();
    expect(received).toEqual([]);
  });

  it("drops input queued behind an in-flight write when closed mid-write", async () => {
    const queue = createPtyInputQueue(writeFn, onError);
    queue.write("first");
    await tick();
    queue.write("queued");
    queue.close();
    queue.write("after close");
    inFlight.shift()!.resolve();
    await tick();
    expect(received).toEqual(["first"]);
    expect(inFlight).toEqual([]);
  });

  it("drops queued input when closed mid-write and that write then fails", async () => {
    const queue = createPtyInputQueue(writeFn, onError);
    queue.write("first");
    await tick();
    queue.write("queued");
    queue.close();
    inFlight.shift()!.reject(new Error("session gone"));
    await tick();
    expect(received).toEqual(["first"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
