// @vitest-environment node
// WI-RA24.1 — the link-opening seam a plugin hands a document's link to.
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindHostLinks, hostLinks, resetHostLinks } from "./hostLinks";

afterEach(resetHostLinks);

describe("hostLinks", () => {
  it("is a no-op until bound, so a standalone plugin does not throw", () => {
    expect(() => hostLinks.open("https://example.com/", null)).not.toThrow();
  });

  it("hands the bound opener the href and the document it was written in, intact", () => {
    const open = vi.fn();
    bindHostLinks({ open });

    hostLinks.open("../笔记/第二章.md#小节", "/docs/第一章.md");
    hostLinks.open("", null);

    expect(open.mock.calls).toEqual([
      ["../笔记/第二章.md#小节", "/docs/第一章.md"],
      ["", null],
    ]);
  });

  it("reads the binding fresh, so a consumer that captured the seam early still reaches it", () => {
    const captured = hostLinks.open;
    const open = vi.fn();
    bindHostLinks({ open });

    captured("https://late.example/", null);

    expect(open).toHaveBeenCalledWith("https://late.example/", null);
  });

  it("reset restores the no-op", () => {
    const open = vi.fn();
    bindHostLinks({ open });
    resetHostLinks();

    hostLinks.open("https://example.com/", null);

    expect(open).not.toHaveBeenCalled();
  });
});
