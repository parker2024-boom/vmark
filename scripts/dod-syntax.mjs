#!/usr/bin/env node
/**
 * Syntax-aware probes for the plan DoD checkers (scripts/lib/dod-assertions.sh).
 *
 * grep sees text; these see CODE. A `#[path = "x.test.rs"]` inside a block
 * comment, an `it(` on its own line inside a template literal, a
 * `provision::transition` in a doc comment, a journey whose `name:` sits in
 * some other object — each satisfied the line-anchored greps the assertions
 * used to run, and each is exactly the placeholder a DoD checker exists to
 * refuse (audit 20260907 #26, #27, #31, #32). TypeScript and JavaScript go
 * through the TypeScript compiler's parser, the way the repo's other AST
 * gates do (check-ipc-contract, check-mock-boundaries); Rust has no parser in
 * this toolchain, so it gets scripts/lib/rustSource.mjs — comments (nested)
 * and literals blanked before a regex runs, so what it runs over is code.
 * `ts-code-grep` and `rust-code-grep` are the same probe per language, and
 * both take `--keep-strings` for an assertion whose SUBJECT is a literal (an
 * event name, a menu id, an env-var name) rather than an identifier.
 *
 * What a probe proves, and what it does not: `ts-has-test-case` proves the
 * file DECLARES a runnable case; that vitest COLLECTS the file is already a
 * repository-wide invariant — `scripts/check-scripts-parity.test.mjs` reads
 * the four tiers' real include/exclude patterns and fails on any test file on
 * disk matched by no tier or by two — and that it PASSES is `pnpm check:all`'s
 * job. Restating either here would be a second copy of one policy that could
 * only ever agree with the first. Nor does it prove the case is reachable at
 * module evaluation: the obvious structural rule (only `describe` callbacks
 * may nest) was measured against every test file in the repo and refuses a
 * real one — `markdownPipeline/__tests__/performance.test.ts` nests its cases
 * under the ALIAS `describePerf`, which no static rule can recognise as a
 * suite root (audit 20260907 #27). `journey-shape` mirrors
 * e2e/run-journeys.mjs's discovery contract (`export default { name, run }`,
 * `name` a non-empty string, `run` a function) statically, and fails closed
 * on a shape it cannot resolve without executing the module.
 *
 * Usage (exit 0 = the property holds, 1 = it does not, 2 = unreadable input,
 * 64 = usage):
 *   node scripts/dod-syntax.mjs rust-mod-include <module.rs> <x.test.rs>
 *   node scripts/dod-syntax.mjs rust-code-grep [--keep-strings] <regex> <file.rs>...  (prints matching files)
 *   node scripts/dod-syntax.mjs ts-code-grep [--keep-strings] <regex> <file>...
 *   node scripts/dod-syntax.mjs ts-has-test-case <file> [title-substring]
 *   node scripts/dod-syntax.mjs journey-shape <file.mjs>
 *
 * @coordinates-with scripts/lib/dod-assertions.sh — the assertion helpers that call this
 * @coordinates-with scripts/lib/dodSyntaxRust.mjs — the Rust probes
 * @coordinates-with scripts/lib/dodSyntaxTs.mjs — the TypeScript / JavaScript probes
 * @coordinates-with scripts/lib/dodSyntaxJourney.mjs — the journey-shape probe
 * @coordinates-with scripts/lib/rustSource.mjs — the Rust comment/literal lexer
 * @coordinates-with scripts/dod-syntax.test.mjs — the self-test
 * @coordinates-with e2e/run-journeys.mjs — the discovery contract journey-shape mirrors
 * @module scripts/dod-syntax
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import ts from "typescript";
import { rustCodeMatches, rustModIncludes, statelessRe } from "./lib/dodSyntaxRust.mjs";
import { declaredTestCases, parseSource, tsCode } from "./lib/dodSyntaxTs.mjs";
import { journeyShape } from "./lib/dodSyntaxJourney.mjs";
import { isMainModule } from "./lib/isMainModule.mjs";

/** The probes, re-exported: this file is the CLI and the one module the self-test imports. */
export { declaredTestCases, journeyShape, parseSource, rustCodeMatches, rustModIncludes, statelessRe, tsCode };

const USAGE =
  "usage: node scripts/dod-syntax.mjs rust-mod-include <module.rs> <x.test.rs>\n" +
  "       node scripts/dod-syntax.mjs rust-code-grep [--keep-strings] <regex> <file.rs>...\n" +
  "       node scripts/dod-syntax.mjs ts-code-grep [--keep-strings] <regex> <file>...\n" +
  "       node scripts/dod-syntax.mjs ts-has-test-case <file> [title-substring]\n" +
  "       node scripts/dod-syntax.mjs journey-shape <file.mjs>";

// ---------------------------------------------------------------- CLI

/** An exit code raised inside `main` — `--serve` must answer it, not die of it. */
class DodExit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function readOrExit(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    console.error(`dod-syntax: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    throw new DodExit(2);
  }
}

/** `main`, with an unreadable file reported as exit 2 rather than thrown. */
function runOnce(argv) {
  try {
    return main(argv);
  } catch (err) {
    if (err instanceof DodExit) return err.code;
    throw err;
  }
}

/**
 * `--serve`: answer many requests from ONE process. Loading the TypeScript
 * compiler costs ~0.36s, and a DoD phase issues dozens of probes, so one node
 * per probe spent most of a phase starting processes (41 probes, 11s, in the
 * feature-ledger phase 5 — its self-test took eleven minutes and timed out
 * under a parallel gate run). `scripts/lib/dod-assertions.sh` starts one
 * server per shell and falls back to a fresh process when it cannot.
 *
 * Request: one line — the caller's cwd, then argv, joined by U+001F.
 * Reply: `O <line>` per stdout line, `E <line>` per stderr line, then
 * `X <exit code>`. Each request runs with the caller's cwd, so relative paths
 * resolve exactly as they would in a process started there. The argv
 * `--ping` alone is the readiness handshake: `X 0`, cwd untouched, so a
 * caller learns the server is up before it trusts the stream with a probe.
 *
 * `--owner <pid>` (the starting shell's pid): the server exits once that
 * process is gone. End-of-file on stdin is not enough on its own: every
 * background job the shell starts inherits the request pipe's write end, and
 * the server outlived the shell for as long as any of them ran.
 */
async function serve(owner) {
  if (owner !== undefined) {
    setInterval(() => {
      try {
        process.kill(owner, 0);
      } catch (err) {
        if (err?.code === "ESRCH") process.exit(0);
      }
    }, 1000).unref();
  }
  const tagged = (tag, lines) => lines.flatMap((l) => String(l).split("\n")).map((l) => `${tag}\t${l}\n`).join("");
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const [cwd, ...argv] = line.split("\u001f");
    if (argv.length === 1 && argv[0] === "--ping") {
      process.stdout.write("X\t0\n");
      continue;
    }
    const out = [];
    const err = [];
    const { log, error } = console;
    console.log = (...a) => out.push(a.join(" "));
    console.error = (...a) => err.push(a.join(" "));
    let code;
    try {
      process.chdir(cwd);
      code = runOnce(argv);
    } catch (e) {
      err.push(e instanceof Error ? e.message : String(e));
      code = 70;
    } finally {
      console.log = log;
      console.error = error;
    }
    process.stdout.write(`${tagged("O", out)}${tagged("E", err)}X\t${code}\n`);
  }
}

/**
 * The `[--keep-strings] <pattern> <file…>` argument shape both grep subcommands
 * take: `{ keepStrings, re, files }`, or `{ usage: true }` / `{ badPattern }`.
 *
 * ONE parser, because it was written twice — and the pair is exactly how the
 * `lastIndex` defect (see `statelessRe`) came to exist in both branches at once, and how a
 * fix to one of them would have left the other wrong. The
 * regex is built STATELESS here as well as defensively in `rustCodeMatches`,
 * since the `ts-code-grep` branch tests it directly.
 */
function grepArgs(rest) {
  const keepStrings = rest[0] === "--keep-strings";
  const [pattern, ...files] = keepStrings ? rest.slice(1) : rest;
  if (!pattern || files.length === 0) return { usage: true };
  try {
    return { keepStrings, re: statelessRe(new RegExp(pattern)), files };
  } catch (err) {
    return { badPattern: `dod-syntax: invalid pattern ${JSON.stringify(pattern)}: ${err.message}` };
  }
}

/** Report the matching files; exit 0 when at least one matched, 1 otherwise. */
function reportHits(hits) {
  for (const h of hits) console.log(h);
  return hits.length > 0 ? 0 : 1;
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "rust-mod-include": {
      const [mod, base] = rest;
      if (!mod || !base || rest.length !== 2) break;
      if (rustModIncludes(readOrExit(mod), base)) return 0;
      console.error(`${mod}: no active #[path = "${base}"] followed by \`mod …;\` outside comments`);
      return 1;
    }
    case "rust-code-grep": {
      const args = grepArgs(rest);
      if (args.usage) break;
      if (args.badPattern) {
        console.error(args.badPattern);
        return 64;
      }
      return reportHits(
        args.files.filter((f) => rustCodeMatches(readOrExit(f), args.re, { keepStrings: args.keepStrings })),
      );
    }
    case "ts-code-grep": {
      const args = grepArgs(rest);
      if (args.usage) break;
      if (args.badPattern) {
        console.error(args.badPattern);
        return 64;
      }
      return reportHits(
        args.files.filter((f) => {
          const source = readOrExit(f);
          const sf = parseSource(f, source);
          return args.re.test(tsCode(sf, source, { keepStrings: args.keepStrings }));
        }),
      );
    }
    case "ts-has-test-case": {
      const [file, titleIncludes] = rest;
      if (!file || rest.length < 1 || rest.length > 2) break;
      const sf = parseSource(file, readOrExit(file));
      // A file the parser only RECOVERED is not a file whose cases run: error
      // recovery invents nodes, so counting them is counting a guess.
      // journeyShape already refused on this; this did not.
      if (sf.parseDiagnostics.length > 0) {
        console.error(`${file}: does not parse: ${ts.flattenDiagnosticMessageText(sf.parseDiagnostics[0].messageText, " ")}`);
        return 1;
      }
      if (declaredTestCases(sf, { titleIncludes }) > 0) return 0;
      const what = titleIncludes === undefined ? "" : ` whose title contains ${JSON.stringify(titleIncludes)}`;
      console.error(
        `${file}: declares no runnable it()/test() case${what} ` +
          "(a title with no handler, a comment, a string, skip and todo do not count)",
      );
      return 1;
    }
    case "journey-shape": {
      const [file] = rest;
      if (!file || rest.length !== 1) break;
      const r = journeyShape(parseSource(file, readOrExit(file)));
      if (r.ok) return 0;
      console.error(`${file}: ${r.reason}`);
      return 1;
    }
    default:
      break;
  }
  console.error(USAGE);
  return 64;
}

if (isMainModule(import.meta.url)) {
  const [cmd, flag, pid, ...extra] = process.argv.slice(2);
  if (cmd === "--serve") {
    const owner = flag === "--owner" ? Number(pid) : undefined;
    if ((flag !== undefined && !(Number.isInteger(owner) && owner > 0)) || extra.length > 0) {
      console.error("usage: node scripts/dod-syntax.mjs --serve [--owner <pid>]");
      process.exit(64);
    }
    await serve(owner);
  } else process.exit(runOnce(process.argv.slice(2)));
}
