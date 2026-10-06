// @vitest-environment node
// WI-RA3.4 — the counterexamples the cron properties found, pinned as fixed
// cases so each stays covered when the generator's walk misses it.

import { describe, it, expect } from "vitest";
import { CronParseError, parseCron } from "./parse";
import { cronToReadable } from "./readable";

describe("parseCron — a value is a plain decimal number or a name", () => {
  it.each([
    ["an empty list item", "0, * * * *"],
    ["a leading comma", ",0 * * * *"],
    ["only a comma", ", * * * *"],
    ["hexadecimal", "0 0 0x1F * *"],
    ["binary", "0 0 0b11 * *"],
    ["an exponent", "1e1 * * * *"],
    ["a decimal point", "5.0 * * * *"],
    ["a sign", "+5 * * * *"],
    ["an empty range end", "0 0 1- * *"],
    ["an empty step base", "/5 * * * *"],
  ])("rejects %s", (_label, input) => {
    expect(() => parseCron(input)).toThrow(CronParseError);
  });

  it("still accepts leading zeros", () => {
    expect(parseCron("05 007 * * *").fields.slice(0, 2)).toEqual([[5], [7]]);
  });

  it("names the field and the token in the error", () => {
    expect(() => parseCron("0 0 0x1F * *")).toThrow(/'0X1F'.*dom/);
  });
});

describe("parseCron — names in any letter case, in every position", () => {
  it.each([
    ["a single name", "0 0 * * mon", [1]],
    ["a range", "0 0 * * mon-fri", [1, 2, 3, 4, 5]],
    ["a mixed-case range", "0 0 * * Mon-Fri", [1, 2, 3, 4, 5]],
    ["a number-to-name range", "0 0 * * 0-sun", [0]],
    ["a stepped range", "0 0 * * mon-fri/2", [1, 3, 5]],
    ["a list", "0 0 * * sat,sun", [0, 6]],
  ])("%s", (_label, input, expected) => {
    expect(parseCron(input).fields[4]).toEqual(expected);
  });

  it("reads month names the same way", () => {
    expect(parseCron("0 0 1 jan-mar *").fields[3]).toEqual([1, 2, 3]);
  });
});

describe("parseCron — the interval is the smallest gap between two fires", () => {
  it.each([
    ["minutes wrap into the next hour when every hour fires", "0,58 * * * *", 2],
    ["but not when the next hour does not fire", "0,58 5 * * *", 58],
    ["they do wrap into an adjacent listed hour", "0,58 5,6 * * *", 2],
    ["a step that does not divide the hour, one hour only", "*/7 0 * * *", 7],
    ["the same step, every hour", "*/7 * * * *", 4],
    ["hours wrap across midnight", "0 0,23 * * *", 60],
    ["a step over the hours wraps too", "0 */5 * * *", 240],
    ["every minute of one hour", "* 14 * * *", 1],
    ["once a day", "30 2 * * *", 1440],
  ])("%s: %s", (_label, input, expected) => {
    expect(parseCron(input).intervalMinutes).toBe(expected);
  });

  it("does not warn about throttling for two fires 58 minutes apart", () => {
    expect(cronToReadable("0,58 5 * * *").throttled).toBe(false);
    expect(cronToReadable("*/7 0 * * *").throttled).toBe(false);
  });

  it("still warns when every hour makes the wrap real", () => {
    expect(cronToReadable("0,58 * * * *").throttled).toBe(true);
  });
});

describe("cronToReadable — 'every N minutes' only for an even progression", () => {
  it.each([
    ["a gap in the progression", "0,10,30 * * * *", "at minute 0, 10, 30 of every hour"],
    ["a progression that stops early", "0,15,30 * * * *", "at minute 0, 15, 30 of every hour"],
    ["a step that does not divide the hour", "*/25 * * * *", "at minute 0, 25, 50 of every hour"],
  ])("%s", (_label, input, expected) => {
    expect(cronToReadable(input).text).toBe(expected);
  });

  it.each([
    ["*/20 * * * *", 20],
    ["0,30 * * * *", 30],
    ["0-59/5 * * * *", 5],
  ])("still says it of %s", (input, n) => {
    expect(cronToReadable(input).time).toEqual({ kind: "every-n-minutes", n });
  });
});
