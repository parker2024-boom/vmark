// @vitest-environment node
// WI-RA14A.2 — the app tier runs in one fixed time zone and locale.
//
// A test that formats a date or a number reads the process's time zone and
// ICU default locale. Unpinned, those are the developer's machine settings,
// so an assertion on the actual string passes on one machine and fails on the
// next. The pin lives in `vitest.config.ts`, set in the main process before
// any worker starts: ICU reads the default locale once per process, so
// setting it from inside a worker (a setup file) is too late.
import { describe, expect, it } from "vitest";
import { TEST_LOCALE, TEST_TIME_ZONE } from "../../vitest.shared.ts";

describe("app-tier clock environment", () => {
  it("runs in the pinned time zone", () => {
    expect(process.env.TZ).toBe(TEST_TIME_ZONE);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(TEST_TIME_ZONE);
    expect(new Date(0).getHours()).toBe(0);
  });

  it("formats with the pinned default locale", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().locale).toBe(TEST_LOCALE);
    expect((1234567.5).toLocaleString()).toBe("1,234,567.5");
    expect(new Date(Date.UTC(2026, 0, 2, 15, 4, 5)).toLocaleTimeString()).toBe("3:04:05 PM");
  });
});
