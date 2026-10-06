/**
 * The Markdown spec tier's entries in the baseline ratchet manifest.
 *
 * Purpose: the spec tier registers fifteen ledgers and corpora under three
 * contracts — declared-divergence ledgers (additions report), vendored
 * corpora (opposite polarity: examples may only be added) and two TypeScript
 * ledgers that predate the tier. They change together, with the spec tier,
 * and almost never with the gate baselines in the main manifest, so they
 * live here and are spread into `MANIFEST.entries` there. The entry schema is
 * documented in the main manifest's header.
 *
 * @coordinates-with scripts/baselineRatchetManifest.mjs — spreads these into MANIFEST.entries
 * @coordinates-with scripts/baselineRatchetSpecLedgers.mjs — the comparators these entries name
 * @module scripts/lib/baselineRatchet/specTierEntries
 */

export const SPEC_TIER_ENTRIES = [
  // ── Markdown spec tier (plan ADR-5) ──────────────────────────────────
  // Declared-divergence ledgers: one identity per record; additions report
  // (visible in the diff), removals are tightening. Value drift is the spec
  // gates' own staleness check, not the ratchet's.
  {
    path: "src/utils/markdownPipeline/__tests__/spec/specDeltas.json",
    checks: [{ mode: "custom", comparator: "specConformanceRecords", onAdd: "report" }],
  },
  {
    path: "src/utils/markdownPipeline/__tests__/spec/specRoundtripDeltas.json",
    checks: [{ mode: "custom", comparator: "specRoundtripRecords", onAdd: "report" }],
  },
  // Vendored corpora: OPPOSITE polarity — content-addressed example
  // identities that may only be added, so removing or editing an example
  // fails even when the same commit updates the registry digest to match.
  {
    path: "src/utils/markdownPipeline/__tests__/spec/corpus/commonmark-0.31.2.json",
    checks: [
      { mode: "custom", comparator: "specCorpusExamples", direction: "no-remove", onAdd: "report" },
    ],
  },
  {
    path: "src/utils/markdownPipeline/__tests__/spec/corpus/gfm-extensions.json",
    checks: [
      { mode: "custom", comparator: "specCorpusExamples", direction: "no-remove", onAdd: "report" },
    ],
  },
  // The external corpora — identical contract per file.
  ...[
    "cmark-regression.json",
    "cmark-gfm-regression.json",
    "cmark-gfm-extensions.json",
    "pulldown-cjk-emphasis.json",
    "pulldown-wikilinks.json",
    "pulldown-math.json",
    "markdown-it-extras.json",
    "markdown-it-xss.json",
    "tiptap-conversion.json",
  ].map((file) => ({
    path: `src/utils/markdownPipeline/__tests__/spec/corpus/${file}`,
    checks: [
      { mode: "custom", comparator: "specCorpusExamples", direction: "no-remove", onAdd: "report" },
    ],
  })),
  // Pre-existing ledgers that predate the spec tier, previously
  // unregistered (self-attesting): now pinned via source-text parsing.
  {
    path: "src/utils/markdownPipeline/__tests__/conformance/expectedDeltas.ts",
    format: "text",
    checks: [{ mode: "custom", comparator: "tsExpectedDeltas", onAdd: "report" }],
  },
  {
    path: "src/utils/markdownPipeline/__tests__/fidelity/fidelityLedger.ts",
    format: "text",
    checks: [{ mode: "custom", comparator: "tsFidelityLedger", onAdd: "report" }],
  },
];
