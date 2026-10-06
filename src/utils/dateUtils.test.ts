// @vitest-environment node
/**
 * Tests for date utilities.
 *
 * WI-RA14A.2 — every test runs against a fixed clock in the app tier's pinned
 * time zone (UTC) and locale (en-US), so the formatted strings are asserted
 * exactly and "today" cannot roll over mid-test at midnight.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatRelativeTime,
  formatExactTime,
  formatSnapshotTime,
  groupByDay,
} from "./dateUtils";

/** Thursday 2026-01-15 14:30:45 UTC. */
const NOW = Date.UTC(2026, 0, 15, 14, 30, 45);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * ICU builds differ on the space before AM/PM: some emit U+202F (narrow
 * no-break space), some a plain space. Which one is not this module's
 * behaviour, so it is folded to a plain space; every other character is
 * asserted exactly.
 */
const plain = (s: string) => s.replaceAll(String.fromCharCode(0x202f), " ");

beforeEach(() => {
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dateUtils", () => {
  describe("formatRelativeTime", () => {
    it('returns "just now" for < 5 seconds ago', () => {
      expect(formatRelativeTime(NOW - 2 * SECOND)).toBe("just now");
    });

    it("returns seconds ago for < 60 seconds", () => {
      expect(formatRelativeTime(NOW - 30 * SECOND)).toBe("30s ago");
    });

    it("returns minutes ago for < 60 minutes", () => {
      expect(formatRelativeTime(NOW - 5 * MINUTE)).toBe("5m ago");
    });

    it("returns hours ago for >= 60 minutes", () => {
      expect(formatRelativeTime(NOW - 2 * HOUR)).toBe("2h ago");
    });

    it("handles boundary at 5 seconds", () => {
      expect(formatRelativeTime(NOW - 5 * SECOND)).toBe("5s ago");
    });

    it("handles boundary at 59 seconds", () => {
      expect(formatRelativeTime(NOW - 59 * SECOND)).toBe("59s ago");
    });

    it("handles boundary at 60 seconds", () => {
      expect(formatRelativeTime(NOW - 60 * SECOND)).toBe("1m ago");
    });

    it("handles boundary at 59 minutes", () => {
      expect(formatRelativeTime(NOW - 59 * MINUTE)).toBe("59m ago");
    });

    it("handles boundary at 60 minutes", () => {
      expect(formatRelativeTime(NOW - 60 * MINUTE)).toBe("1h ago");
    });
  });

  describe("formatExactTime", () => {
    it("formats the time of day in the default locale", () => {
      expect(plain(formatExactTime(NOW))).toBe("2:30:45 PM");
    });

    it("formats morning and evening distinctly", () => {
      expect(plain(formatExactTime(Date.UTC(2026, 0, 15, 9, 30, 0)))).toBe("9:30:00 AM");
      expect(plain(formatExactTime(Date.UTC(2026, 0, 15, 21, 30, 0)))).toBe("9:30:00 PM");
    });
  });

  describe("formatSnapshotTime", () => {
    it("prefixes 'Today' for today's timestamps", () => {
      expect(plain(formatSnapshotTime(NOW))).toBe("Today 02:30 PM");
    });

    it("prefixes 'Yesterday' for yesterday's timestamps", () => {
      expect(plain(formatSnapshotTime(NOW - DAY))).toBe("Yesterday 02:30 PM");
    });

    it("shows the month and day for older timestamps", () => {
      expect(plain(formatSnapshotTime(NOW - 7 * DAY))).toBe("Jan 8, 02:30 PM");
    });

    it("treats the first second of today as today and the last of yesterday as yesterday", () => {
      const midnight = Date.UTC(2026, 0, 15);
      expect(plain(formatSnapshotTime(midnight))).toBe("Today 12:00 AM");
      expect(plain(formatSnapshotTime(midnight - SECOND))).toBe("Yesterday 11:59 PM");
    });
  });

  describe("groupByDay", () => {
    interface TestItem {
      id: number;
      timestamp: number;
    }

    it("groups items by day", () => {
      const items: TestItem[] = [
        { id: 1, timestamp: NOW },
        { id: 2, timestamp: NOW - SECOND },
        { id: 3, timestamp: NOW - DAY },
      ];

      const groups = groupByDay(items, (item) => item.timestamp);

      expect([...groups.keys()]).toEqual(["Today", "Yesterday"]);
      expect(groups.get("Today")?.map((i) => i.id)).toEqual([1, 2]);
      expect(groups.get("Yesterday")?.map((i) => i.id)).toEqual([3]);
    });

    it("handles empty array", () => {
      const groups = groupByDay<TestItem>([], (item) => item.timestamp);
      expect(groups.size).toBe(0);
    });

    it("handles single item", () => {
      const groups = groupByDay([{ id: 1, timestamp: NOW }], (item) => item.timestamp);
      expect([...groups.keys()]).toEqual(["Today"]);
    });

    it("labels items from 5 days ago with the weekday, month and day", () => {
      const groups = groupByDay([{ id: 1, timestamp: NOW - 5 * DAY }], (item) => item.timestamp);
      expect([...groups.keys()]).toEqual(["Saturday, Jan 10"]);
    });

    it("preserves item order within groups", () => {
      const items: TestItem[] = [
        { id: 1, timestamp: NOW },
        { id: 2, timestamp: NOW - SECOND },
        { id: 3, timestamp: NOW - 2 * SECOND },
      ];

      const groups = groupByDay(items, (item) => item.timestamp);

      expect(groups.get("Today")?.map((i) => i.id)).toEqual([1, 2, 3]);
    });
  });
});
