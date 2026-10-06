// @vitest-environment node
// WI-RA24.4 — the save dialog's suggested name for a document with no heading
// and no usable tab title is the app's translated untitled name
// (common:untitled), not the English literal "Untitled". The app tier's i18n is
// English-only, so `i18n.t` returns a marker for the key.
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useTabStore } from "@/stores/tabStore";
import { buildDefaultSavePath } from "./saveDialog";

function translateUntitledAs(name: string) {
  vi.spyOn(i18n, "t").mockImplementation(((key: string) =>
    key === "common:untitled" ? name : key) as typeof i18n.t);
}

const fileName = (path: string) => path.split(/[\\/]/).pop();

afterEach(() => {
  vi.restoreAllMocks();
  useTabStore.setState({ tabs: {}, activeTabId: {} });
});

describe("buildDefaultSavePath for a document with nothing to name it by", () => {
  it.each([
    ["Sans titre", "Sans titre.md"],
    ["未命名", "未命名.md"],
  ])("suggests the translated untitled name %j", async (translated, expected) => {
    translateUntitledAs(translated);
    const path = await buildDefaultSavePath("main", "no-such-tab", "no heading here", null);
    expect(fileName(path)).toBe(expected);
  });

  it("still prefers the document's first heading", async () => {
    translateUntitledAs("Sans titre");
    const path = await buildDefaultSavePath("main", "no-such-tab", "# Plan de route\n\ntexte", null);
    expect(fileName(path)).toBe("Plan de route.md");
  });

  it("keeps a path the document already has", async () => {
    translateUntitledAs("Sans titre");
    await expect(buildDefaultSavePath("main", "t1", "", "/docs/a.md")).resolves.toBe("/docs/a.md");
  });
});
