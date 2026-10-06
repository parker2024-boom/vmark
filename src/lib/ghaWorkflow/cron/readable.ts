/**
 * Purpose: Describe a parsed GitHub Actions schedule.cron expression as
 *   structured parts callers translate (`form.trigger.cron.*`), plus flag
 *   schedules that GHA throttles silently (under-5-minute interval) per
 *   actionlint policy.
 *
 *   Why a custom parser instead of cronstrue: cronstrue is ~12 KB
 *   gzipped (lazy) and adds a dep; the syntax surface is small enough to
 *   cover exhaustively with stronger tests for the GHA-specific edge cases
 *   (throttle threshold, day-of-week range rendering).
 *
 * @coordinates-with parse.ts — the grammar, the field values and the interval
 * @module lib/ghaWorkflow/cron/readable
 */

import { DOW_NAMES, MONTH_NAMES, parseCron } from "./parse";

// The parser's surface, re-exported: callers have always found it here.
export { CronParseError, parseCron } from "./parse";

/**
 * Discriminated union for the time portion of a cron expression.
 * Callers translate each kind via i18n keys
 * `form.trigger.cron.<kind>` (readable.ts
 * was previously English-only with no path to localized output).
 */
type CronTimePart =
  | { kind: "every-minute" }
  | { kind: "every-n-minutes"; n: number }
  | { kind: "at-time"; time: string }
  | { kind: "at-times"; times: string[] }
  | { kind: "at-times-many"; visible: string[]; rest: number }
  | { kind: "every-minute-of-hour"; hours: string }
  | { kind: "every-hour-on-the-hour" }
  | { kind: "at-minute-of-every-hour"; minutes: string };

/**
 * Modifiers attached to the time clause:
 *   - dom: day-of-month list (e.g., "1, 15")
 *   - month: month abbreviations (e.g., "Jan, Feb")
 *   - dowList: day-of-week as comma list (e.g., "Mon, Wed")
 *   - dowRange: contiguous range (e.g., { from: "Mon", to: "Fri" })
 */
interface CronModifiers {
  dom?: string;
  month?: string;
  dowList?: string;
  dowRange?: { from: string; to: string };
}

export interface CronReadable {
  /** English fallback rendering (for callers that don't translate). */
  text: string;
  /** Structured time clause for translation. */
  time: CronTimePart;
  /** Structured modifiers for translation. */
  modifiers: CronModifiers;
  /** True when the smallest fire interval is below 5 minutes. */
  throttled: boolean;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function buildTimePart(
  minutes: number[] | null,
  hours: number[] | null,
): CronTimePart {
  if (minutes === null && hours === null) {
    return { kind: "every-minute" };
  }
  if (minutes === null) {
    return { kind: "every-minute-of-hour", hours: hours!.join(", ") };
  }
  if (hours === null) {
    if (minutes.length === 1 && minutes[0] === 0) {
      return { kind: "every-hour-on-the-hour" };
    }
    return {
      kind: "at-minute-of-every-hour",
      minutes: minutes.join(", "),
    };
  }
  const times: string[] = [];
  for (const h of hours) {
    for (const m of minutes) {
      times.push(`${pad2(h)}:${pad2(m)}`);
    }
  }
  if (times.length === 1) return { kind: "at-time", time: times[0] };
  if (times.length <= 4) return { kind: "at-times", times };
  return {
    kind: "at-times-many",
    visible: times.slice(0, 3),
    rest: times.length - 3,
  };
}

function buildModifiers(
  dom: number[] | null,
  month: number[] | null,
  dow: number[] | null,
): CronModifiers {
  const out: CronModifiers = {};
  if (dom !== null) out.dom = dom.join(", ");
  if (month !== null) {
    out.month = month.map((m) => MONTH_NAMES[m - 1]).join(", ");
  }
  if (dow !== null) {
    if (dow.length >= 3) {
      const sorted = [...dow].sort((a, b) => a - b);
      let isRange = true;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i - 1] + 1) {
          isRange = false;
          break;
        }
      }
      if (isRange) {
        out.dowRange = {
          from: DOW_NAMES[sorted[0]],
          to: DOW_NAMES[sorted[sorted.length - 1]],
        };
      } else {
        out.dowList = dow.map((d) => DOW_NAMES[d]).join(", ");
      }
    } else {
      out.dowList = dow.map((d) => DOW_NAMES[d]).join(", ");
    }
  }
  return out;
}

/** English-only fallback renderer for callers that don't translate. */
function renderTimePartEnglish(part: CronTimePart): string {
  switch (part.kind) {
    case "every-minute":
      return "every minute";
    case "every-n-minutes":
      return `every ${part.n} minutes`;
    case "at-time":
      return `at ${part.time}`;
    case "at-times":
      return `at ${part.times.join(", ")}`;
    case "at-times-many":
      return `at ${part.visible.join(", ")} (+${part.rest} more)`;
    case "every-minute-of-hour":
      return `every minute of hour ${part.hours}`;
    case "every-hour-on-the-hour":
      return "every hour on the hour";
    case "at-minute-of-every-hour":
      return `at minute ${part.minutes} of every hour`;
  }
}

function renderModifiersEnglish(mod: CronModifiers): string {
  let out = "";
  if (mod.dom) out += ` on day-of-month ${mod.dom}`;
  if (mod.month) out += ` in ${mod.month}`;
  if (mod.dowRange) out += ` on ${mod.dowRange.from}-${mod.dowRange.to}`;
  else if (mod.dowList) out += ` on ${mod.dowList}`;
  return out;
}

export function cronToReadable(input: string): CronReadable {
  const parsed = parseCron(input);
  const [minute, hour, dom, month, dow] = parsed.fields;

  let time: CronTimePart;
  if (
    minute !== null &&
    minute.length > 1 &&
    hour === null &&
    dom === null &&
    month === null &&
    dow === null
  ) {
    // "Every N minutes" is a claim about the whole hour: 0, N, 2N, … with
    // nothing missing and the wrap into the next hour also N long. A list
    // whose members merely divide by its smallest gap (`0,10,30`) is not one.
    const interval = parsed.intervalMinutes;
    const isProgression =
      60 % interval === 0 &&
      minute.length === 60 / interval &&
      minute.every((m, i) => m === i * interval);
    if (isProgression) {
      time = { kind: "every-n-minutes", n: interval };
    } else {
      time = buildTimePart(minute, hour);
    }
  } else {
    time = buildTimePart(minute, hour);
  }

  const modifiers = buildModifiers(dom, month, dow);
  const text = renderTimePartEnglish(time) + renderModifiersEnglish(modifiers);

  return {
    text,
    time,
    modifiers,
    throttled: parsed.intervalMinutes < 5,
  };
}
