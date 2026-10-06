/**
 * Purpose: validate the feature map (`scripts/feature-map.json`) before
 *   anything is measured — its shape, then every path, `dataOnly` declaration,
 *   doc and flag default against the tree.
 *
 * Shared by the ledger generator, which refuses to render from a stale spine,
 * and the feature-map gate, which runs the same validation on every check so a
 * stale spine is caught without regenerating the ledger.
 *
 * @coordinates-with scripts/gen-feature-ledger.mjs — refuses to generate on these errors
 * @coordinates-with scripts/check-feature-map.mjs — runs the same validation as a gate
 * @coordinates-with scripts/lib/featureMeasure.mjs — the one enumeration each path is probed with
 * @coordinates-with scripts/lib/settingsDefaultsSource.mjs — flag-default verification
 * @module scripts/lib/featureSpine
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { featureInventory, normalizePaths, run } from "./featureMeasure.mjs";
import { DEFAULTS_REL, verifyFlagDefaults } from "./settingsDefaultsSource.mjs";

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The feature map's SHAPE, before any of it is measured. Nothing validated it,
 * so `{"features": []}` produced an authoritative EMPTY ledger, and a feature
 * with `"paths": []` reached `find`/`tokei`/`git log` with no path operand at
 * all — where `find` defaults to the working directory and would have measured
 * the whole repository as that one feature.
 */
export function spineShapeErrors(spine) {
  const errors = [];
  if (!isPlainObject(spine) || !Array.isArray(spine.features)) return ["feature-map.json: expected a `features` array"];
  if (spine.features.length === 0) return ["feature-map.json: `features` is empty — an empty ledger is not a measurement"];
  const seen = new Set();
  spine.features.forEach((f, i) => {
    const where = `feature-map.json: features[${i}]`;
    if (!isPlainObject(f)) return errors.push(`${where} is not an object`);
    if (typeof f.name !== "string" || f.name.trim() === "") return errors.push(`${where} has no non-empty \`name\``);
    if (seen.has(f.name)) errors.push(`${where}: duplicate feature name ${JSON.stringify(f.name)}`);
    seen.add(f.name);
    if (!Array.isArray(f.paths) || f.paths.length === 0) return errors.push(`${f.name}: \`paths\` must be a non-empty array — a feature with no path measures nothing, or everything`);
    for (const p of f.paths) {
      if (typeof p !== "string" || p.trim() === "") errors.push(`${f.name}: a path is not a non-empty string (${JSON.stringify(p)})`);
    }
    const normalized = normalizePaths(f.paths.filter((p) => typeof p === "string" && p.trim() !== ""));
    if (normalized.length === 0 || normalized.some((p) => p === "" || p === ".")) {
      errors.push(`${f.name}: a path normalises away to nothing or to the repository root ("" / "." / "./") — the measurement would have no path operand, and \`find\` with none walks the working directory`);
    }
    // An absolute path, or one that climbs out of the repository, measures a
    // tree that is not this one.
    for (const p of normalized.filter((q) => q.startsWith("/") || q === ".." || q.startsWith("../"))) {
      errors.push(`${f.name}: a path is absolute or climbs out of the repository -> ${p}`);
    }
  });
  return errors;
}

/**
 * Stale-spine errors: a path that does not exist or holds NO file, a path with
 * no CODE file that is not declared under the feature's `dataOnly` (and a
 * declared one that holds code, or is not one of its `paths`), a doc that does
 * not exist, a flag default that disagrees.
 */
export function spineErrors(root, spine, defaultsSource, runner = run) {
  const shape = spineShapeErrors(spine);
  if (shape.length) return shape;
  const errors = [];
  for (const f of spine.features) {
    const dataOnly = new Set(f.dataOnly ?? []);
    for (const d of dataOnly) if (!f.paths.includes(d)) errors.push(`${f.name}: dataOnly names a path that is not one of its paths -> ${d}`);
    for (const p of f.paths) {
      if (!existsSync(path.join(root, p))) { errors.push(`${f.name}: path does not exist -> ${p}`); continue; }
      // ONE enumeration of the SAME tree `existsSync` just probed:
      // the all-files and code-file views are two filters over it,
      // not two `find` runs that could disagree.
      const files = featureInventory([p], runner, root);
      if (files.all.length === 0) { errors.push(`${f.name}: path holds no file at all (its measured zeros would be about nothing) -> ${p}`); continue; }
      const hasCode = files.code.length > 0;
      if (!hasCode && !dataOnly.has(p)) errors.push(`${f.name}: path holds no code file — declare it under dataOnly if it is data (locales, bundled resources), else the code moved -> ${p}`);
      if (hasCode && dataOnly.has(p)) errors.push(`${f.name}: path is declared dataOnly but holds code files -> ${p}`);
    }
    if (f.doc && !existsSync(path.join(root, f.doc))) errors.push(`${f.name}: doc does not exist -> ${f.doc}`);
  }
  if (defaultsSource === null) errors.push(`${DEFAULTS_REL} missing — flag defaults cannot be verified`);
  else errors.push(...verifyFlagDefaults(spine.features, defaultsSource));
  return errors;
}
