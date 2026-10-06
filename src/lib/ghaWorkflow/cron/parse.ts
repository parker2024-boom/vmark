/**
 * Purpose: Parse a GitHub Actions schedule.cron expression into the explicit
 *   values each field allows, and compute the smallest interval between two
 *   fires (what the throttle warning is decided on).
 *
 *   GHA cron syntax is the standard POSIX 5-field form:
 *     minute (0-59) | hour (0-23) | day-of-month (1-31) |
 *     month (1-12 / JAN-DEC) | day-of-week (0-7 / SUN-SAT, where
 *                             both 0 and 7 are Sunday)
 *
 *   Each field accepts: `*`, `N`, `N-M`, `N,M`, `* /N`, `N-M/K`.
 *
 * Key decisions:
 *   - A value is a plain decimal number or a name, and nothing else. `Number()`
 *     alone also reads the empty string as 0 and accepts `0x1F`, `1e1` and
 *     `5.0`, so `0,` meant "minute 0" and a hexadecimal day parsed.
 *   - Names are case-insensitive in every position: the whole field is
 *     upper-cased once, before any pattern looks at it.
 *   - The interval is measured on the schedule's fire times within a day,
 *     wrapping across midnight, so `0,58 5 * * *` (two fires 58 minutes apart)
 *     is not mistaken for `0,58 * * * *` (two minutes apart every hour).
 *     Day, month and weekday restrictions are ignored: they can only make a
 *     gap longer, and the warning is about the shortest one.
 *   - Every failure is a `CronParseError`. Nothing else is thrown for any
 *     input string; `readable.property.test.ts` holds that.
 *
 * @coordinates-with readable.ts — renders a parsed expression
 * @module lib/ghaWorkflow/cron/parse
 */

export const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

interface FieldSpec {
  name: "minute" | "hour" | "dom" | "month" | "dow";
  min: number;
  max: number;
  /** Upper-cased name → value. */
  aliases?: Map<string, number>;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  {
    name: "month",
    min: 1,
    max: 12,
    aliases: new Map(MONTH_NAMES.map((m, i) => [m.toUpperCase(), i + 1])),
  },
  {
    name: "dow",
    min: 0,
    max: 7,
    aliases: new Map(DOW_NAMES.map((d, i) => [d.toUpperCase(), i])),
  },
];

export interface ParsedCron {
  raw: string;
  /** Each field as the explicit list of allowed values. `null` = wildcard. */
  fields: (number[] | null)[];
  /** Smallest interval in minutes between fires. */
  intervalMinutes: number;
}

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

/** `token` is already upper-cased. */
function parseValue(token: string, field: FieldSpec): number {
  const alias = field.aliases?.get(token);
  if (alias !== undefined) return alias;
  const n = /^\d+$/.test(token) ? Number(token) : Number.NaN;
  if (!Number.isInteger(n) || n < field.min || n > field.max) {
    throw new CronParseError(
      `Value '${token}' out of range for ${field.name} (${field.min}-${field.max})`,
    );
  }
  return n;
}

/** `spec` is already upper-cased. */
function expandRange(spec: string, field: FieldSpec): number[] | null {
  if (spec === "*") return null;

  const stepMatch = spec.match(
    /^(\*|\d+(?:-\d+)?|[A-Z]+(?:-[A-Z]+)?)\/(\d+)$/,
  );
  if (stepMatch) {
    const [, basePart, stepStr] = stepMatch;
    const step = Number(stepStr);
    if (step <= 0) {
      throw new CronParseError(
        `Invalid step '${step}' in ${field.name} field`,
      );
    }
    let start = field.min;
    let end = field.max;
    if (basePart !== "*") {
      const range = expandRange(basePart, field);
      if (range !== null && range.length > 0) {
        start = range[0];
        end = range[range.length - 1];
      }
    }
    const out: number[] = [];
    for (let v = start; v <= end; v += step) out.push(v);
    return out;
  }

  const rangeMatch = spec.match(/^([A-Z0-9]+)-([A-Z0-9]+)$/);
  if (rangeMatch) {
    const a = parseValue(rangeMatch[1], field);
    const b = parseValue(rangeMatch[2], field);
    if (a > b) {
      throw new CronParseError(
        `Reversed range '${spec}' in ${field.name} field`,
      );
    }
    const out: number[] = [];
    for (let v = a; v <= b; v++) out.push(v);
    return out;
  }

  return [parseValue(spec, field)];
}

const EVERY_MINUTE = Array.from({ length: 60 }, (_, i) => i);
const EVERY_HOUR = Array.from({ length: 24 }, (_, i) => i);
const MINUTES_PER_DAY = 1440;

/**
 * The smallest gap, in minutes, between two consecutive fires of a schedule
 * with these minutes and hours on every day — the last fire of one day and
 * the first of the next included.
 */
function smallestInterval(minutes: number[] | null, hours: number[] | null): number {
  // Both lists are ascending, so the fire times come out ascending too.
  const fires: number[] = [];
  for (const h of hours ?? EVERY_HOUR) {
    for (const m of minutes ?? EVERY_MINUTE) fires.push(h * 60 + m);
  }
  let smallest = fires[0] + MINUTES_PER_DAY - fires[fires.length - 1];
  for (let i = 1; i < fires.length; i++) {
    smallest = Math.min(smallest, fires[i] - fires[i - 1]);
  }
  return smallest;
}

export function parseCron(input: string): ParsedCron {
  const trimmed = input.trim();
  if (!trimmed) throw new CronParseError("Empty cron expression");
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `Expected 5 fields, got ${parts.length}: '${trimmed}'`,
    );
  }
  const fields: (number[] | null)[] = parts.map((part, i) => {
    const field = FIELDS[i];
    const segments = part.toUpperCase().split(",");
    const collected = new Set<number>();
    let anyWildcard = false;
    for (const seg of segments) {
      const expanded = expandRange(seg, field);
      if (expanded === null) {
        anyWildcard = true;
      } else {
        for (const v of expanded) collected.add(v);
      }
    }
    if (anyWildcard) return null;
    if (field.name === "dow" && collected.has(7)) {
      collected.delete(7);
      collected.add(0);
    }
    return [...collected].sort((a, b) => a - b);
  });

  return {
    raw: trimmed,
    fields,
    intervalMinutes: smallestInterval(fields[0], fields[1]),
  };
}
