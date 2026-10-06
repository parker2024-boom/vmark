// WI-RA22.1 — a settings reset or a map-key removal in another window reaches this window
import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";
import { initialState } from "@/stores/settingsStore/defaults";
import { handleSettingsStorageEvent } from "./useSettingsSync";

function storageEvent(state: Record<string, unknown>): StorageEvent {
  return new StorageEvent("storage", {
    key: "vmark-settings",
    newValue: JSON.stringify({ state }),
  });
}

/** The blob another window writes right after its own Reset to defaults. */
function resetBlob(): Record<string, unknown> {
  return structuredClone(initialState) as unknown as Record<string, unknown>;
}

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
});

describe("cross-window reset reaches nullable settings", () => {
  it("clears skipVersion and lastCheckTimestamp when the other window reset", () => {
    const store = useSettingsStore.getState();
    store.updateUpdateSetting("skipVersion", "2.0.0");
    store.updateUpdateSetting("lastCheckTimestamp", 1_700_000_000_000);

    handleSettingsStorageEvent(storageEvent(resetBlob()));

    expect(useSettingsStore.getState().update.skipVersion).toBeNull();
    expect(useSettingsStore.getState().update.lastCheckTimestamp).toBeNull();
  });

  it("applies a nullable value of the declared type from another window", () => {
    const blob = resetBlob();
    (blob.update as Record<string, unknown>).skipVersion = "3.1.4";

    handleSettingsStorageEvent(storageEvent(blob));

    expect(useSettingsStore.getState().update.skipVersion).toBe("3.1.4");
  });
});

describe("cross-window map edits reach map-valued settings", () => {
  it("removes an association the other window removed", () => {
    useSettingsStore
      .getState()
      .updateFormatsSetting("associations", { ".csv": "data", ".mmd": "diagram" });

    const blob = resetBlob();
    (blob.formats as Record<string, unknown>).associations = { ".mmd": "diagram" };
    handleSettingsStorageEvent(storageEvent(blob));

    expect(useSettingsStore.getState().formats.associations).toEqual({ ".mmd": "diagram" });
  });

  it("empties the map when the other window reset it", () => {
    useSettingsStore
      .getState()
      .updateFormatsSetting("associations", { ".csv": "data" });

    handleSettingsStorageEvent(storageEvent(resetBlob()));

    expect(useSettingsStore.getState().formats.associations).toEqual({});
  });

  it("handles a CJK map key the same way", () => {
    useSettingsStore
      .getState()
      .updateFormatsSetting("associations", { ".文档": "markdown", ".csv": "data" });

    const blob = resetBlob();
    (blob.formats as Record<string, unknown>).associations = { ".文档": "markdown" };
    handleSettingsStorageEvent(storageEvent(blob));

    expect(useSettingsStore.getState().formats.associations).toEqual({ ".文档": "markdown" });
  });
});

describe("the reconcile base is never this window's live state", () => {
  it("does not mutate the shared defaults object", () => {
    const snapshot = JSON.stringify(initialState);
    const blob = resetBlob();
    (blob.terminal as Record<string, unknown>).fontSize = 9999; // clamped in place
    handleSettingsStorageEvent(storageEvent(blob));
    expect(JSON.stringify(initialState)).toBe(snapshot);
  });
});
