// @vitest-environment node
// WI-RA20.5 — a title with nothing usable in it falls back to the app's
// translated untitled name (common:untitled, the name new tabs get), not
// the English literal "Untitled". The app tier's i18n mock is English-only,
// so `i18n.t` is replaced with a marker to prove the name comes from the key.
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { toSafeFilename } from "./closeSaveShared";

function translateUntitledAs(name: string) {
  vi.spyOn(i18n, "t").mockImplementation(((key: string) =>
    key === "common:untitled" ? name : key) as typeof i18n.t);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toSafeFilename fallback", () => {
  it.each(["", "   ", "\t\n"])("uses the translated untitled name for %j", (title) => {
    translateUntitledAs("Sans titre");
    expect(toSafeFilename(title)).toBe("Sans titre");
  });

  it("uses a CJK untitled name as is", () => {
    translateUntitledAs("未命名");
    expect(toSafeFilename("")).toBe("未命名");
  });

  it("sanitizes the translated name like any other title", () => {
    translateUntitledAs("Sans/titre:");
    expect(toSafeFilename("")).toBe("Sans-titre-");
  });

  it("keeps a usable title and never consults the fallback", () => {
    translateUntitledAs("Sans titre");
    expect(toSafeFilename("  notes: draft  ")).toBe("notes- draft");
  });
});
