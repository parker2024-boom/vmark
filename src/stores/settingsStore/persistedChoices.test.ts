// WI-RA21.5 — persisted settings choices survive a restart.
//
// Two defects, one theme — the user's stored choice lost to a default:
//   - The default link protocols were unioned back into the list on EVERY
//     load, so a removed default came back at the next launch. That list is
//     the link-scheme allowlist: a user could not remove a scheme.
//   - A persisted `state` that is not an object (a string, an array) spread
//     its indices into the store as settings named "0", "1", ...
//
// The real store and its persist config, over the test environment's
// localStorage. Each `launch()` is a fresh module graph, so the store is
// created and hydrated again — what an app restart does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "@/stores/settingsStore/defaults";

const KEY = "vmark-settings";
const DEFAULT_PROTOCOLS = [...initialState.advanced.customLinkProtocols];
const seed = (state: unknown, version: number) =>
  localStorage.setItem(KEY, JSON.stringify({ state, version }));
const onDisk = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as { state: typeof initialState; version: number };

/** One launch: a fresh store, hydrated from whatever localStorage holds. */
async function launch() {
  vi.resetModules();
  const store = await import("@/stores/settingsStore");
  const settings = store.useSettingsStore;
  const version = settings.persist.getOptions().version ?? 0;
  return {
    settings,
    version,
    introduced: store.LINK_PROTOCOLS_INTRODUCED,
    protocols: () => settings.getState().advanced.customLinkProtocols,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("link protocols: the user's list is the list", () => {
  it("a default the user removed stays removed after a restart", async () => {
    const kept = DEFAULT_PROTOCOLS.filter((p) => p !== "dict");
    (await launch()).settings.getState().updateAdvancedSetting("customLinkProtocols", kept);

    const app = await launch();

    expect(app.protocols()).toEqual(kept);
  });

  it("an emptied list stays empty, and a list of the user's own scheme stays exactly that", async () => {
    (await launch()).settings.getState().updateAdvancedSetting("customLinkProtocols", []);
    expect((await launch()).protocols()).toEqual([]);

    (await launch()).settings.getState().updateAdvancedSetting("customLinkProtocols", ["zotero"]);
    expect((await launch()).protocols()).toEqual(["zotero"]);
  });

  it("a blob from before the versioned list gets the defaults once, then the user's removals hold", async () => {
    // Version-1 builds unioned the defaults in on every load, so a v1 user has
    // effectively always had them: the upgrade adds them once, keeping theirs
    // (and dropping what is not a scheme name at all).
    seed({ advanced: { customLinkProtocols: ["zotero", 42, "obsidian"] } }, 1);

    const upgraded = await launch();
    expect(upgraded.protocols()).toEqual([...DEFAULT_PROTOCOLS, "zotero"]);
    expect(onDisk().version).toBe(upgraded.version);

    upgraded.settings.getState().updateAdvancedSetting("customLinkProtocols", ["zotero"]);
    expect((await launch()).protocols()).toEqual(["zotero"]);
  });

  it("every default protocol is introduced by a schema version this build has reached", async () => {
    // A default added without a version entry would reach new installs only:
    // an upgraded user's list is theirs, and nothing would add it.
    const { introduced, version } = await launch();
    const offered = new Set(Object.values(introduced).flat());
    expect(DEFAULT_PROTOCOLS.filter((p) => !offered.has(p))).toEqual([]);
    expect(Math.max(...Object.keys(introduced).map(Number))).toBeLessThanOrEqual(version);
  });

  it("a current blob without the field falls back to the defaults", async () => {
    const { version } = await launch();
    seed({ advanced: { developerMode: true } }, version);

    const app = await launch();

    expect(app.protocols()).toEqual(DEFAULT_PROTOCOLS);
    expect(app.settings.getState().advanced.developerMode).toBe(true);
  });
});

describe("a persisted state that is not an object is rejected", () => {
  it.each([
    ["a string", "settings"],
    ["an array", ["a", "b"]],
    ["a number", 42],
    ["a boolean", true],
  ])("%s leaves the defaults and leaks no keys", async (_label, state) => {
    const { version } = await launch();
    seed(state, version);

    const after = (await launch()).settings.getState();

    for (const key of ["0", "1", "2", "length"]) expect(after).not.toHaveProperty(key);
    expect(after.general).toEqual(initialState.general);
    expect(after.advanced.customLinkProtocols).toEqual(DEFAULT_PROTOCOLS);
  });
});

