// @vitest-environment node
// WI-RA3.4 — properties of the cron parser and its rendering, over generated
// expressions rather than hand-picked ones.
/**
 * The example suite beside this file pins named cases (a zero step, day-of-week 7,
 * minute wrap-around). These properties pin what must hold for EVERY input:
 *
 *   - parsing arbitrary text never fails with anything but `CronParseError`;
 *   - a valid expression expands to exactly the values a second, independent
 *     reading of the grammar gives;
 *   - the parsed fields have a normal form that parses back to themselves;
 *   - the reported interval is the real smallest gap between two fires;
 *   - rendering is total, and what it says is true of the schedule.
 *
 * No pinned seed: fast-check prints `seed` and `path` on failure, and a shrunk
 * counterexample belongs in the example suite as a fixed case.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CronParseError, cronToReadable, parseCron } from "./readable";

// ---- a second reading of the grammar ----------------------------------------

interface Field {
  name: string;
  min: number;
  max: number;
  aliases: string[]; // alias for value `min + i`, or none
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59, aliases: [] },
  { name: "hour", min: 0, max: 23, aliases: [] },
  { name: "dom", min: 1, max: 31, aliases: [] },
  { name: "month", min: 1, max: 12, aliases: MONTHS },
  { name: "dow", min: 0, max: 7, aliases: DAYS },
];

/** One comma-separated segment: its source text and the values it stands for. */
interface Segment {
  text: string;
  values: number[] | null; // null: a wildcard
}

const stepped = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
};

function segment(field: Field): fc.Arbitrary<Segment> {
  const value = fc.integer({ min: field.min, max: field.max });
  const spell = (v: number): fc.Arbitrary<string> => {
    const alias = field.aliases[v - field.min];
    return alias === undefined ? fc.constant(String(v)) : fc.constantFrom(String(v), alias);
  };
  const single = value.chain((v) => spell(v).map((text) => ({ text, values: [v] })));
  const range = fc
    .tuple(value, value)
    .map(([a, b]) => (a <= b ? [a, b] : [b, a]))
    .chain(([a, b]) =>
      fc.tuple(spell(a), spell(b)).map(([ta, tb]) => ({ text: `${ta}-${tb}`, values: stepped(a, b, 1) })),
    );
  const step = fc.integer({ min: 1, max: field.max + 3 });
  const wildcardStep = step.map((k) => ({ text: `*/${k}`, values: stepped(field.min, field.max, k) }));
  const rangeStep = fc
    .tuple(value, value, step)
    .map(([a, b, k]) => (a <= b ? ([a, b, k] as const) : ([b, a, k] as const)))
    .map(([a, b, k]) => ({ text: `${a}-${b}/${k}`, values: stepped(a, b, k) }));
  const wildcard = fc.constant<Segment>({ text: "*", values: null });
  return fc.oneof(single, single, range, wildcardStep, rangeStep, wildcard);
}

interface FieldCase {
  text: string;
  values: number[] | null;
}

function fieldCase(field: Field): fc.Arbitrary<FieldCase> {
  return fc.array(segment(field), { minLength: 1, maxLength: 3 }).map((segments) => {
    const text = segments.map((s) => s.text).join(",");
    if (segments.some((s) => s.values === null)) return { text, values: null };
    const set = new Set(segments.flatMap((s) => s.values ?? []));
    if (field.name === "dow" && set.delete(7)) set.add(0); // 0 and 7 are both Sunday
    return { text, values: [...set].sort((a, b) => a - b) };
  });
}

const validCron = fc
  .tuple(...FIELDS.map(fieldCase))
  .map((fields) => ({ text: fields.map((f) => f.text).join(" "), fields: fields.map((f) => f.values) }));

/** The normal form: every field as `*` or its explicit value list. */
const normalForm = (fields: (number[] | null)[]): string =>
  fields.map((f) => (f === null ? "*" : f.join(","))).join(" ");

const range = (from: number, to: number): number[] => stepped(from, to, 1);

/** Smallest gap, in minutes, between two fires of a schedule that runs daily. */
function smallestGap(minutes: number[] | null, hours: number[] | null): number {
  const fires: number[] = [];
  for (const h of hours ?? range(0, 23)) for (const m of minutes ?? range(0, 59)) fires.push(h * 60 + m);
  fires.sort((a, b) => a - b);
  let smallest = fires[0] + 1440 - fires[fires.length - 1]; // across midnight
  for (let i = 1; i < fires.length; i += 1) smallest = Math.min(smallest, fires[i] - fires[i - 1]);
  return smallest;
}

const RUNS = { numRuns: 1000 };

// ---- properties ------------------------------------------------------------

describe("parseCron — arbitrary input", () => {
  const cronish = fc
    .array(
      fc.constantFrom("*", "/", "-", ",", " ", "  ", "\t", "0", "1", "5", "7", "9", "60", "MON", "jan", "x", ".", "e", "+", ""),
      { maxLength: 24 },
    )
    .map((parts) => parts.join(""));

  it.each([
    ["any string", fc.string()],
    ["any string of code points", fc.string({ unit: "binary" })],
    ["strings made of cron's own characters", cronish],
  ])("returns or throws CronParseError, never anything else: %s", (_label, input) => {
    fc.assert(
      fc.property(input, (text) => {
        for (const run of [parseCron, cronToReadable]) {
          try {
            run(text);
          } catch (error) {
            expect(error).toBeInstanceOf(CronParseError);
          }
        }
      }),
      { numRuns: 3000 },
    );
  });
});

describe("parseCron — valid expressions", () => {
  it("expands every field to exactly the values the grammar says", () => {
    fc.assert(
      fc.property(validCron, ({ text, fields }) => {
        expect(parseCron(text).fields).toEqual(fields);
      }),
      RUNS,
    );
  });

  it("keeps every value in range, ascending and unique, with Sunday as 0", () => {
    fc.assert(
      fc.property(validCron, ({ text }) => {
        parseCron(text).fields.forEach((values, i) => {
          if (values === null) return;
          const top = FIELDS[i].name === "dow" ? 6 : FIELDS[i].max;
          expect(values.length).toBeGreaterThan(0);
          values.forEach((v, j) => {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(FIELDS[i].min);
            expect(v).toBeLessThanOrEqual(top);
            if (j > 0) expect(v).toBeGreaterThan(values[j - 1]);
          });
        });
      }),
      RUNS,
    );
  });

  it("has a normal form that parses back to the same schedule", () => {
    fc.assert(
      fc.property(validCron, ({ text }) => {
        const parsed = parseCron(text);
        const normal = normalForm(parsed.fields);
        const again = parseCron(normal);
        expect(again.fields).toEqual(parsed.fields);
        expect(again.intervalMinutes).toBe(parsed.intervalMinutes);
        expect(normalForm(again.fields)).toBe(normal);
        expect(cronToReadable(normal)).toEqual(cronToReadable(text));
      }),
      RUNS,
    );
  });

  it("reads names in any letter case", () => {
    fc.assert(
      fc.property(validCron, fc.infiniteStream(fc.boolean()), ({ text }, flips) => {
        const mixed = [...text].map((ch) => (flips.next().value ? ch.toLowerCase() : ch.toUpperCase())).join("");
        expect(parseCron(mixed).fields).toEqual(parseCron(text).fields);
        expect(parseCron(text.toLowerCase()).fields).toEqual(parseCron(text).fields);
      }),
      RUNS,
    );
  });

  it("ignores the amount of whitespace between and around fields", () => {
    const gap = fc.constantFrom(" ", "  ", "\t", " \t ");
    fc.assert(
      fc.property(validCron, fc.array(gap, { minLength: 6, maxLength: 6 }), ({ text }, gaps) => {
        const parts = text.split(" ");
        const spaced = gaps[0] + parts.map((part, i) => part + gaps[i + 1]).join("");
        expect(parseCron(spaced).fields).toEqual(parseCron(text).fields);
        expect(parseCron(spaced).raw).toBe(spaced.trim());
      }),
      RUNS,
    );
  });

  it("reports the smallest gap between two fires as the interval", () => {
    fc.assert(
      fc.property(validCron, ({ text }) => {
        const { fields, intervalMinutes } = parseCron(text);
        expect(intervalMinutes).toBe(smallestGap(fields[0], fields[1]));
      }),
      RUNS,
    );
  });
});

describe("parseCron — field boundaries", () => {
  const withField = (index: number, value: string): string =>
    ["0", "0", "1", "1", "0"].map((part, i) => (i === index ? value : part)).join(" ");

  it.each(FIELDS.map((field, index) => [field.name, field, index] as const))(
    "%s accepts its minimum and maximum and nothing outside them",
    (_name, field, index) => {
      expect(() => parseCron(withField(index, String(field.min)))).not.toThrow();
      expect(() => parseCron(withField(index, String(field.max)))).not.toThrow();
      fc.assert(
        fc.property(
          // Above the maximum, and — where the minimum is not 0 — below it.
          fc.integer({ min: field.max + 1, max: field.max + 1000 }).map((n) =>
            field.min > 0 && n % 2 === 0 ? n % field.min : n,
          ),
          (outside) => {
            for (const text of [`${outside}`, `${field.min}-${outside}`, `${outside}-${outside}`, `${field.min},${outside}`]) {
              expect(() => parseCron(withField(index, text))).toThrow(CronParseError);
            }
          },
        ),
        { numRuns: 200 },
      );
    },
  );

  it.each(FIELDS.map((field, index) => [field.name, field, index] as const))(
    "%s rejects anything that is not a plain decimal number or a name",
    (_name, field, index) => {
      const notNumbers = ["", "0x1", "0b1", "0o1", "1e0", "1.0", "+1", "1.", ".1", "１", "Infinity", "NaN", "01x"];
      for (const token of notNumbers) {
        for (const text of [token, `${token},${field.min}`, `${field.min},${token}`, `${field.min}-${token}`, `${token}/2`]) {
          expect(() => parseCron(withField(index, text)), `'${text}' in ${field.name}`).toThrow(CronParseError);
        }
      }
    },
  );

  it("rejects a zero step and accepts any positive one", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (step) => {
        expect(() => parseCron(`*/${step} * * * *`)).not.toThrow();
        expect(parseCron(`*/${step} * * * *`).fields[0]?.[0]).toBe(0);
      }),
      { numRuns: 200 },
    );
    expect(() => parseCron("*/0 * * * *")).toThrow(CronParseError);
    expect(() => parseCron("0-10/0 * * * *")).toThrow(CronParseError);
  });
});

describe("cronToReadable — total, and true of the schedule", () => {
  it("renders every valid expression without holes", () => {
    fc.assert(
      fc.property(validCron, ({ text }) => {
        const readable = cronToReadable(text);
        expect(readable.text.length).toBeGreaterThan(0);
        expect(readable.text).not.toMatch(/undefined|NaN|null|\[object/);
        expect(readable.text).toBe(readable.text.trim());
      }),
      RUNS,
    );
  });

  it("flags a schedule as throttled exactly when two fires are under five minutes apart", () => {
    fc.assert(
      fc.property(validCron, ({ text, fields }) => {
        expect(cronToReadable(text).throttled).toBe(smallestGap(fields[0], fields[1]) < 5);
      }),
      RUNS,
    );
  });

  it("says 'every N minutes' only of a schedule that fires every N minutes", () => {
    fc.assert(
      fc.property(validCron, ({ text, fields }) => {
        const { time } = cronToReadable(text);
        if (time.kind !== "every-n-minutes") return;
        expect(fields[0]).toEqual(stepped(0, 59, time.n));
        expect(60 % time.n).toBe(0);
        expect(fields.slice(1)).toEqual([null, null, null, null]);
      }),
      RUNS,
    );
  });

  it("lists every fire time, or counts the ones it leaves out", () => {
    fc.assert(
      fc.property(validCron, ({ text, fields }) => {
        const { time } = cronToReadable(text);
        const [minutes, hours] = fields;
        if (minutes === null || hours === null) return;
        const count = minutes.length * hours.length;
        if (time.kind === "at-time") expect(count).toBe(1);
        else if (time.kind === "at-times") expect(time.times).toHaveLength(count);
        else if (time.kind === "at-times-many") expect(time.visible.length + time.rest).toBe(count);
        else throw new Error(`unexpected time kind ${time.kind} for fixed minutes and hours`);
      }),
      RUNS,
    );
  });

  it("names a day, month or weekday restriction exactly when the field has one", () => {
    fc.assert(
      fc.property(validCron, ({ text, fields }) => {
        const { modifiers } = cronToReadable(text);
        expect(modifiers.dom !== undefined).toBe(fields[2] !== null);
        expect(modifiers.month !== undefined).toBe(fields[3] !== null);
        const hasDow = modifiers.dowList !== undefined || modifiers.dowRange !== undefined;
        expect(hasDow).toBe(fields[4] !== null);
        expect(modifiers.dowList !== undefined && modifiers.dowRange !== undefined).toBe(false);
      }),
      RUNS,
    );
  });
});
