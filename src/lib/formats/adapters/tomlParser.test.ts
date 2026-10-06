// WI-RA24.9 — the TOML parser loads on first use: callers get null until it
// arrives, the load starts on that first ask, and subscribers hear once when
// it is ready. Each case gets a fresh module, since the parser is module state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

async function freshParserModule() {
  vi.resetModules();
  return import("./tomlParser");
}

afterEach(() => vi.restoreAllMocks());

describe("the lazily loaded TOML parser", () => {
  it("answers null at first, starts loading, and parses once it has arrived", async () => {
    const m = await freshParserModule();
    expect(m.tomlParser()).toBeNull();
    const parse = await m.loadTomlParser();
    expect(m.tomlParser()).toBe(parse);
    expect(parse('"名前" = "値"\n[a]\nb = 1\n')).toEqual({ 名前: "値", a: { b: 1 } });
    expect(() => parse("a = ")).toThrow();
  });

  it("loads once however many callers ask", async () => {
    const m = await freshParserModule();
    const [a, b] = await Promise.all([m.loadTomlParser(), m.loadTomlParser()]);
    expect(a).toBe(b);
  });

  it("tells each subscriber once when the parser arrives, and not after unsubscribing", async () => {
    const m = await freshParserModule();
    const kept = vi.fn();
    const dropped = vi.fn();
    m.onTomlParserLoaded(kept);
    const stop = m.onTomlParserLoaded(dropped);
    stop();
    await m.loadTomlParser();
    await m.loadTomlParser();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("re-renders a component with the parser once it has loaded", async () => {
    const m = await freshParserModule();
    const { result } = renderHook(() => m.useTomlParser());
    expect(result.current).toBeNull();
    await act(async () => void (await m.loadTomlParser()));
    expect(typeof result.current).toBe("function");
  });
});
