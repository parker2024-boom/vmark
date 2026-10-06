// @vitest-environment node
// WI-RA9A.2 — the notice seam both image-paste flows report through.
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindHostNotify, hostNotify, resetHostNotify } from "./hostNotify";

afterEach(resetHostNotify);

describe("hostNotify", () => {
  it("is a no-op until bound, so a standalone plugin does not throw", () => {
    expect(() => hostNotify.info("x")).not.toThrow();
    expect(() => hostNotify.error("x")).not.toThrow();
  });

  it("routes each severity to its own bound presenter, message intact", () => {
    const info = vi.fn();
    const error = vi.fn();
    bindHostNotify({ info, error });

    hostNotify.info("图片未找到 — pasted as text");
    hostNotify.error("");

    expect(info.mock.calls).toEqual([["图片未找到 — pasted as text"]]);
    expect(error.mock.calls).toEqual([[""]]);
  });

  it("reads the binding fresh, so a consumer that captured the seam early still reaches it", () => {
    const captured = hostNotify.info;
    const info = vi.fn();
    bindHostNotify({ info });

    captured("late");

    expect(info).toHaveBeenCalledWith("late");
  });

  it("rebinding replaces rather than merges, and reset restores the no-ops", () => {
    const first = vi.fn();
    bindHostNotify({ info: first });
    bindHostNotify({ error: vi.fn() });
    hostNotify.info("a");
    expect(first).not.toHaveBeenCalled();

    const error = vi.fn();
    bindHostNotify({ error });
    resetHostNotify();
    hostNotify.error("b");
    expect(error).not.toHaveBeenCalled();
  });
});
