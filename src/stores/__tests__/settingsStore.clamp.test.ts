// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  useSettingsStore,
  clampMergedSettings,
  CLAMP_RANGES,
} from "../settingsStore";
import { reconcileSettings } from "../settingsStore/reconcile";
import { buildHistorySettings } from "@/utils/historyTypes";

describe("section updater clamping (D4)", () => {
  beforeEach(() => {
    useSettingsStore.getState().resetSettings();
  });

  it("clamps an absurdly large fontSize down to the max", () => {
    useSettingsStore.getState().updateAppearanceSetting("fontSize", 999);
    expect(useSettingsStore.getState().appearance.fontSize).toBe(48);
  });

  it("clamps a too-small fontSize up to the min", () => {
    useSettingsStore.getState().updateAppearanceSetting("fontSize", 1);
    expect(useSettingsStore.getState().appearance.fontSize).toBe(8);
  });

  it("leaves an in-range value untouched", () => {
    useSettingsStore.getState().updateAppearanceSetting("fontSize", 20);
    expect(useSettingsStore.getState().appearance.fontSize).toBe(20);
  });

  it("clamps terminal panelRatio into its drag bounds", () => {
    useSettingsStore.getState().updateTerminalSetting("panelRatio", 5);
    expect(useSettingsStore.getState().terminal.panelRatio).toBe(0.8);
  });

  it("does not touch unbounded / non-numeric fields", () => {
    useSettingsStore.getState().updateGeneralSetting("language", "zh-CN");
    expect(useSettingsStore.getState().general.language).toBe("zh-CN");
  });
});

describe("clampMergedSettings (persist boundary, D4)", () => {
  it("clamps corrupt persisted numeric values in place", () => {
    const merged = {
      appearance: { fontSize: 999, lineHeight: 0.1, editorWidth: 50 },
      terminal: { scrollback: 99_999_999 },
      general: { tabSize: 99 },
    };
    clampMergedSettings(merged);
    expect(merged.appearance.fontSize).toBe(48);
    expect(merged.appearance.lineHeight).toBe(1);
    expect(merged.appearance.editorWidth).toBe(50);
    expect(merged.terminal.scrollback).toBe(200_000);
    expect(merged.general.tabSize).toBe(8);
  });

  it("ignores non-object groups and non-numeric values", () => {
    const merged = { appearance: "evil", terminal: { scrollback: "nope" } };
    expect(() => clampMergedSettings(merged as Record<string, unknown>)).not.toThrow();
  });

  it("every clamp range is a valid [min, max] pair", () => {
    for (const ranges of Object.values(CLAMP_RANGES)) {
      for (const [min, max] of Object.values(ranges!)) {
        expect(min).toBeLessThanOrEqual(max);
      }
    }
  });
});

// WI-RA10A.14 — history is kept for at least one day. A retention of 0 days
// puts the prune cutoff at "now", so the snapshot a save has just written is
// older than the cutoff and is deleted by the prune that follows it.
describe("historyMaxAgeDays has a floor of one day", () => {
  const STORAGE_KEY = "vmark-settings";
  const retention = () => useSettingsStore.getState().general.historyMaxAgeDays;

  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().resetSettings();
  });

  afterEach(() => {
    localStorage.clear();
    useSettingsStore.getState().resetSettings();
  });

  it.each([0, -1, 0.5, Number.MIN_VALUE])("raises a programmatic set of %s to 1", (value) => {
    useSettingsStore.getState().updateGeneralSetting("historyMaxAgeDays", value);
    expect(retention()).toBe(1);
  });

  it.each([1, 7, 14, 30])("leaves the %s-day preset the settings page offers untouched", (value) => {
    useSettingsStore.getState().updateGeneralSetting("historyMaxAgeDays", value);
    expect(retention()).toBe(value);
  });

  it("raises a persisted 0 to 1 when the settings are loaded", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { general: { historyMaxAgeDays: 0 } }, version: 1 }),
    );

    useSettingsStore.persist.rehydrate();

    expect(retention()).toBe(1);
  });

  it("raises a 0 arriving from another window's settings blob", () => {
    const live = useSettingsStore.getState() as unknown as Record<string, unknown>;

    const merged = reconcileSettings(live, { general: { historyMaxAgeDays: 0 } });

    expect((merged.general as { historyMaxAgeDays: number }).historyMaxAgeDays).toBe(1);
  });

  it("hands the history layer a cutoff that lies in the past", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { general: { historyMaxAgeDays: 0 } }, version: 1 }),
    );
    useSettingsStore.persist.rehydrate();

    const { maxAgeDays } = buildHistorySettings(useSettingsStore.getState().general);
    const now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;

    // The prune keeps `timestamp >= cutoff`; a snapshot stamped a moment ago
    // must be on the keeping side.
    expect(now - 1).toBeGreaterThanOrEqual(cutoff);
  });
});
