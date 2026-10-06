/**
 * Purpose: turn the bundled dependency closure into license TEXTS — the part
 * MIT, BSD, ISC and Apache require a binary distribution to reproduce — and
 * refuse, by returning errors, whenever a bundled component has none.
 *
 * Pure: every filesystem read arrives as an injected function, so the
 * self-test drives it with in-memory trees and the CLI with the real one.
 *
 * Three sources, three collectors:
 *   - npm packages — the license and notice files each package ships; a
 *     package that ships none is filled from `scripts/third-party-licenses/`,
 *     text fetched from its repository at the pinned version, source recorded.
 *   - Rust crates — `cargo about generate --format json`, regrouped by text.
 *   - embedded components — code compiled INTO a bundled package (Graphviz in
 *     the viz.js wasm, the Node.js runtime inside the pkg-built sidecar). No
 *     package manager reports these, so each is recorded against the host
 *     package version it was verified for, and a host that moves fails until
 *     someone re-checks what it embeds.
 *
 * Every vendored entry must still be needed: one whose package now ships its
 * own text, or is no longer bundled at that version, is an error. Stale data
 * that passes quietly is how a notice file drifts away from the product.
 *
 * @coordinates-with scripts/lib/thirdPartyLicensesRender.mjs — renders what this collects
 * @coordinates-with scripts/gen-third-party-licenses.mjs — the CLI that does the IO
 * @coordinates-with scripts/gen-third-party-licenses.test.mjs — the self-test
 * @module scripts/lib/thirdPartyLicenses
 */
import path from "node:path";

export const VENDORED_MANIFEST = "scripts/third-party-licenses/vendored.json";

const LICENSE_STEM = /^(?:licen[cs]e|copying|notice|unlicense)(?:[-._][^/]*)?$/i;
const LICENSE_SUFFIX = /[-_.]licen[cs]e(?:\.[a-z0-9]+)?$/i;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|d\.[cm]?ts|json|map)$/i;

/** Whether a file at a package root is a license or notice text, not code. */
export function isLicenseFileName(name) {
  if (CODE_FILE.test(name)) return false;
  return LICENSE_STEM.test(name) || LICENSE_SUFFIX.test(name);
}

/** Byte-stable text: no BOM, LF only, no trailing spaces, no outer blank lines. */
export function normalizeText(text) {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

const key = (name, version) => `${name}@${version}`;

/** Ascending by code unit: locale-free, so every machine sorts alike. */
export function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve every npm package to its license texts.
 *
 * @param {object} input
 * @param {{name: string, version: string, license: string, dir: string}[]} input.packages
 * @param {(dir: string) => string[]} input.listFiles regular files at a package root
 * @param {(file: string) => string} input.readText
 * @param {{packages: object[]}} input.vendored the parsed vendored manifest
 * @param {(file: string) => string} input.readVendored reads a vendored text by its manifest name
 * @returns {{entries: object[], errors: string[]}}
 */
export function collectNpm({ packages, listFiles, readText, vendored, readVendored }) {
  const errors = [];
  if (packages.length === 0) {
    return { entries: [], errors: ["the npm production closure is empty — `pnpm licenses list` returned nothing"] };
  }
  const vendoredByKey = new Map(vendored.packages.map((v) => [key(v.name, v.version), v]));
  const bundled = new Set(packages.map((p) => key(p.name, p.version)));
  const entries = [];

  for (const pkg of packages) {
    const id = key(pkg.name, pkg.version);
    const texts = listFiles(pkg.dir)
      .filter(isLicenseFileName)
      .sort(byCodeUnit)
      .map((file) => ({ file, text: normalizeText(readText(path.join(pkg.dir, file))) }))
      .filter((t) => t.text !== "");
    const fallback = vendoredByKey.get(id);

    if (texts.length > 0) {
      if (fallback) {
        errors.push(`vendored entry ${id} is stale: the package ships its own license file — delete the entry and its text`);
      }
      entries.push({ name: pkg.name, version: pkg.version, license: pkg.license, source: null, texts });
      continue;
    }
    if (!fallback) {
      errors.push(`${id} (${pkg.license}) ships no license file and has no vendored text in ${VENDORED_MANIFEST}`);
      continue;
    }
    const text = normalizeText(readVendored(fallback.file));
    if (text === "") {
      errors.push(`vendored text ${fallback.file} for ${id} is empty`);
      continue;
    }
    entries.push({
      name: pkg.name,
      version: pkg.version,
      license: fallback.license,
      source: fallback.source,
      texts: [{ file: fallback.file, text }],
    });
  }

  for (const v of vendored.packages) {
    const id = key(v.name, v.version);
    if (!bundled.has(id)) {
      errors.push(
        `vendored entry ${id} is stale: no bundled package has that name and version — refresh it for the version now bundled, or delete it`,
      );
    }
  }
  return { entries, errors };
}

/**
 * Regroup cargo-about's JSON by license and normalised text.
 *
 * @param {{licenses: {name: string, id: string, text: string, used_by: {crate: {name: string, version: string}}[]}[]}} about
 * @param {{exclude?: string[]}} [options] crate names to leave out — the app's
 *   own crate is not third-party, and listing it would put the app version in
 *   the file, so every release bump would rewrite it
 * @returns {{groups: {license: string, text: string, users: string[]}[], errors: string[]}}
 */
export function collectRust(about, { exclude = [] } = {}) {
  const errors = [];
  if (!Array.isArray(about?.licenses) || about.licenses.length === 0) {
    return { groups: [], errors: ["cargo-about reported no Rust licenses — the Rust half would be empty"] };
  }
  const groups = new Map();
  for (const lic of about.licenses) {
    const license = `${lic.name} (${lic.id})`;
    const users = lic.used_by.filter((u) => !exclude.includes(u.crate.name)).map((u) => `${u.crate.name} ${u.crate.version}`);
    if (users.length === 0) continue;
    const text = normalizeText(lic.text ?? "");
    if (text === "") {
      errors.push(`cargo-about gave ${license} no text (used by ${users.join(", ")})`);
      continue;
    }
    const groupKey = `${license}\u0000${text}`;
    const group = groups.get(groupKey) ?? { license, text, users: new Set() };
    for (const user of users) group.users.add(user);
    groups.set(groupKey, group);
  }
  const sorted = [...groups.values()]
    .map((g) => ({ license: g.license, text: g.text, users: [...g.users].sort(byCodeUnit) }))
    .sort((a, b) => byCodeUnit(a.license, b.license) || byCodeUnit(a.users[0], b.users[0]));
  return { groups: sorted, errors };
}

/** Whether `pnpm-lock.yaml` text resolves `name@version` (quoted or bare key). */
function lockfileResolves(lockfile, name, version) {
  const id = key(name, version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^ {2}'?${id}'?:`, "m").test(lockfile);
}

/**
 * Resolve the components compiled into bundled packages.
 *
 * @param {object} input
 * @param {{component: string, version: string, license: string, host: {name: string, version: string}, source: string, file: string}[]} input.embedded
 * @param {string} input.lockfile `pnpm-lock.yaml` text
 * @param {(file: string) => string} input.readVendored
 */
export function collectEmbedded({ embedded, lockfile, readVendored }) {
  const errors = [];
  const entries = [];
  for (const e of embedded) {
    const host = key(e.host.name, e.host.version);
    if (!lockfileResolves(lockfile, e.host.name, e.host.version)) {
      errors.push(
        `embedded ${e.component} ${e.version} is recorded against ${host}, which pnpm-lock.yaml no longer resolves — re-check which version the host embeds and refresh the vendored text`,
      );
      continue;
    }
    const text = normalizeText(readVendored(e.file));
    if (text === "") {
      errors.push(`vendored text ${e.file} for embedded ${e.component} is empty`);
      continue;
    }
    entries.push({ ...e, text });
  }
  return { entries, errors };
}
