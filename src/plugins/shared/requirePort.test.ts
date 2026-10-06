// WI-RA17F.7 — requirePort: a bound port passes through, an absent one is a typed, named error.
/**
 * The per-extension half (every popup extension routes its ports through
 * this) lives with the host that binds them:
 * services/assembly/popupPortBinding.test.ts.
 *
 * @coordinates-with plugins/shared/requirePort.ts
 * @module plugins/shared/requirePort.test
 */
import { describe, it, expect } from "vitest";
import { requirePort, UnboundPortError } from "./requirePort";

describe("requirePort", () => {
  it("returns a bound port unchanged", () => {
    const port = { getState: () => 1 };
    expect(requirePort(port, "anyExtension", "store")).toBe(port);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("rejects a %s port with a typed error naming extension and option", (_label, value) => {
    let caught: unknown;
    try {
      requirePort(value, "someExtension", "someOption");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnboundPortError);
    const err = caught as UnboundPortError;
    expect(err.name).toBe("UnboundPortError");
    expect(err.extension).toBe("someExtension");
    expect(err.option).toBe("someOption");
    expect(err.message).toContain("someExtension requires a `someOption` option");
  });

  it("keeps falsy-but-bound values (a port is unbound only when absent)", () => {
    expect(requirePort(0, "e", "o")).toBe(0);
    expect(requirePort("", "e", "o")).toBe("");
  });
});
