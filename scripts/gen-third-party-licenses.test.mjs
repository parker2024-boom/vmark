/**
 * WI-RA15B.2 — the third-party notices generator: every bundled package
 * resolves to license TEXT, the output is deterministic, and a package with no
 * text fails the build instead of shipping a notice file with a hole in it.
 *
 * The pure half (`scripts/lib/thirdPartyLicenses.mjs`) is driven with in-memory
 * fixtures. One test runs the npm half against this repository's real
 * production closure: a dependency bump that drops a license file must turn a
 * pull request red, not a release.
 *
 * @coordinates-with scripts/lib/thirdPartyLicenses.mjs — collection and validation
 * @coordinates-with scripts/lib/thirdPartyLicensesRender.mjs — the text output
 * @coordinates-with scripts/gen-third-party-licenses.mjs — the CLI
 * @module scripts/gen-third-party-licenses.test
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  collectEmbedded,
  collectNpm,
  collectRust,
  isLicenseFileName,
  normalizeText,
} from "./lib/thirdPartyLicenses.mjs";
import { renderNotices } from "./lib/thirdPartyLicensesRender.mjs";
import { appCrateName, listNpmPackages, loadVendored, npmCollectInputs, OUTPUT_REL } from "./gen-third-party-licenses.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const MIT = "MIT License\n\nCopyright (c) Someone\n\nPermission is hereby granted.";

/** An in-memory package tree: `{ "/p/a": { LICENSE: "text" } }`. */
function fakeFs(tree) {
  return {
    listFiles: (dir) => {
      if (!(dir in tree)) throw new Error(`ENOENT ${dir}`);
      return Object.keys(tree[dir]);
    },
    readText: (file) => {
      const dir = path.dirname(file);
      const text = tree[dir]?.[path.basename(file)];
      if (text === undefined) throw new Error(`ENOENT ${file}`);
      return text;
    },
  };
}

const NO_VENDORED = { packages: [], embedded: [] };

function npm(packages, tree, vendored = NO_VENDORED, vendoredTexts = {}) {
  return collectNpm({
    packages,
    ...fakeFs(tree),
    vendored,
    readVendored: (file) => {
      if (!(file in vendoredTexts)) throw new Error(`no vendored text ${file}`);
      return vendoredTexts[file];
    },
  });
}

const CARGO_ABOUT = {
  licenses: [
    {
      name: "MIT License",
      id: "MIT",
      text: "MIT text B",
      used_by: [{ crate: { name: "zeta", version: "1.0.0" } }],
    },
    {
      name: "Apache License 2.0",
      id: "Apache-2.0",
      text: "Apache text",
      used_by: [
        { crate: { name: "beta", version: "0.2.0" } },
        { crate: { name: "alpha", version: "1.2.3" } },
      ],
    },
    {
      name: "MIT License",
      id: "MIT",
      text: "MIT text B\r\n",
      used_by: [{ crate: { name: "eta", version: "2.0.0" } }],
    },
  ],
};

describe("isLicenseFileName", () => {
  it.each([
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "license",
    "LICENCE",
    "LICENSE-MIT",
    "LICENSE-APACHE",
    "LICENSE.APACHE2",
    "COPYING",
    "NOTICE",
    "NOTICE.md",
    "UNLICENSE",
    "MIT-License.txt",
    "license.md",
  ])("accepts %s", (name) => {
    expect(isLicenseFileName(name)).toBe(true);
  });

  it.each(["README.md", "package.json", "license.js", "license-checker.mjs", "licenses.d.ts", "index.js", "CHANGELOG.md"])(
    "rejects %s",
    (name) => {
      expect(isLicenseFileName(name)).toBe(false);
    },
  );
});

describe("normalizeText", () => {
  it("drops a BOM, unifies CRLF and lone CR, trims trailing spaces and outer blank lines", () => {
    expect(normalizeText("﻿\r\n\r\nA  \r\nB\rC\t\n\n\n")).toBe("A\nB\nC");
  });

  it("keeps CJK and other non-ASCII text intact", () => {
    expect(normalizeText("版权所有 © 2024 作者\r\n")).toBe("版权所有 © 2024 作者");
  });

  it("is empty for whitespace-only input", () => {
    expect(normalizeText(" \r\n\t\n")).toBe("");
  });
});

describe("collectNpm", () => {
  it("reads every license and notice file a package ships, in name order", () => {
    const result = npm([{ name: "a", version: "1.0.0", license: "Apache-2.0", dir: "/p/a" }], {
      "/p/a": { "NOTICE": "notice text", "LICENSE": "license text", "index.js": "x" },
    });
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      {
        name: "a",
        version: "1.0.0",
        license: "Apache-2.0",
        source: null,
        texts: [
          { file: "LICENSE", text: "license text" },
          { file: "NOTICE", text: "notice text" },
        ],
      },
    ]);
  });

  it("fails, naming the package, when a bundled package has no license text", () => {
    const result = npm(
      [
        { name: "has", version: "1.0.0", license: "MIT", dir: "/p/has" },
        { name: "bare", version: "2.0.0", license: "MIT", dir: "/p/bare" },
      ],
      { "/p/has": { LICENSE: MIT }, "/p/bare": { "README.md": "readme", "index.js": "x" } },
    );
    expect(result.errors).toEqual([
      "bare@2.0.0 (MIT) ships no license file and has no vendored text in scripts/third-party-licenses/vendored.json",
    ]);
  });

  it("treats a license file that is empty after normalisation as missing", () => {
    const result = npm([{ name: "blank", version: "1.0.0", license: "MIT", dir: "/p/b" }], {
      "/p/b": { LICENSE: " \r\n" },
    });
    expect(result.errors).toEqual([
      "blank@1.0.0 (MIT) ships no license file and has no vendored text in scripts/third-party-licenses/vendored.json",
    ]);
  });

  it("fills a package with no license file from vendored text and records its source", () => {
    const vendored = {
      packages: [{ name: "bare", version: "2.0.0", license: "MIT", source: "https://example.test/LICENSE", file: "bare.txt" }],
      embedded: [],
    };
    const result = npm(
      [{ name: "bare", version: "2.0.0", license: "MIT", dir: "/p/bare" }],
      { "/p/bare": { "index.js": "x" } },
      vendored,
      { "bare.txt": "vendored MIT\r\n" },
    );
    expect(result.errors).toEqual([]);
    expect(result.entries[0]).toMatchObject({
      name: "bare",
      source: "https://example.test/LICENSE",
      texts: [{ file: "bare.txt", text: "vendored MIT" }],
    });
  });

  it("rejects a vendored entry for a package that ships its own license file", () => {
    const vendored = {
      packages: [{ name: "has", version: "1.0.0", license: "MIT", source: "https://example.test", file: "has.txt" }],
      embedded: [],
    };
    const result = npm(
      [{ name: "has", version: "1.0.0", license: "MIT", dir: "/p/has" }],
      { "/p/has": { LICENSE: MIT } },
      vendored,
      { "has.txt": MIT },
    );
    expect(result.errors).toEqual([
      "vendored entry has@1.0.0 is stale: the package ships its own license file — delete the entry and its text",
    ]);
  });

  it("rejects a vendored entry whose package is no longer bundled at that version", () => {
    const vendored = {
      packages: [{ name: "gone", version: "1.0.0", license: "MIT", source: "https://example.test", file: "gone.txt" }],
      embedded: [],
    };
    const result = npm([{ name: "has", version: "1.0.0", license: "MIT", dir: "/p/has" }], { "/p/has": { LICENSE: MIT } }, vendored, {
      "gone.txt": MIT,
    });
    expect(result.errors).toEqual([
      "vendored entry gone@1.0.0 is stale: no bundled package has that name and version — refresh it for the version now bundled, or delete it",
    ]);
  });

  it("fails on an empty closure rather than generating a notice file that lists nothing", () => {
    expect(npm([], {}).errors).toEqual(["the npm production closure is empty — `pnpm licenses list` returned nothing"]);
  });
});

describe("collectRust", () => {
  it("merges identical texts across cargo-about entries and sorts crates", () => {
    const result = collectRust(CARGO_ABOUT);
    expect(result.errors).toEqual([]);
    expect(result.groups).toEqual([
      { license: "Apache License 2.0 (Apache-2.0)", text: "Apache text", users: ["alpha 1.2.3", "beta 0.2.0"] },
      { license: "MIT License (MIT)", text: "MIT text B", users: ["eta 2.0.0", "zeta 1.0.0"] },
    ]);
  });

  it("leaves out the app's own crate, so a version bump does not rewrite the notices", () => {
    const about = {
      licenses: [
        ...CARGO_ABOUT.licenses,
        {
          name: "ISC License",
          id: "ISC",
          text: "ISC text",
          used_by: [{ crate: { name: "vmark", version: "9.9.9" } }],
        },
        {
          name: "ISC License",
          id: "ISC",
          text: "other ISC text",
          used_by: [
            { crate: { name: "vmark", version: "9.9.9" } },
            { crate: { name: "kept", version: "1.0.0" } },
          ],
        },
      ],
    };
    const result = collectRust(about, { exclude: ["vmark"] });
    expect(result.errors).toEqual([]);
    expect(result.groups.flatMap((g) => g.users)).not.toContain("vmark 9.9.9");
    expect(result.groups.find((g) => g.text === "ISC text")).toBeUndefined();
    expect(result.groups.find((g) => g.text === "other ISC text")?.users).toEqual(["kept 1.0.0"]);
  });

  it("fails when cargo-about reports no licenses", () => {
    expect(collectRust({ licenses: [] }).errors).toEqual(["cargo-about reported no Rust licenses — the Rust half would be empty"]);
  });

  it("fails on a license entry with no text", () => {
    const result = collectRust({
      licenses: [{ name: "MIT License", id: "MIT", text: "\n", used_by: [{ crate: { name: "x", version: "1.0.0" } }] }],
    });
    expect(result.errors).toEqual(["cargo-about gave MIT License (MIT) no text (used by x 1.0.0)"]);
  });
});

describe("collectEmbedded", () => {
  const entry = {
    component: "Graphviz",
    version: "16.0.0",
    license: "EPL-2.0",
    host: { name: "@viz-js/viz", version: "3.30.0" },
    source: "https://example.test/LICENSE",
    file: "graphviz.txt",
  };
  const lockfile = "packages:\n\n  '@viz-js/viz@3.30.0':\n    resolution: {}\n  undici@6.29.0:\n    resolution: {}\n";

  it("resolves a component whose host is locked at the recorded version", () => {
    const result = collectEmbedded({ embedded: [entry], lockfile, readVendored: () => "EPL text\r\n" });
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([{ ...entry, text: "EPL text" }]);
  });

  it("matches an unquoted lockfile key too", () => {
    const undici = { ...entry, host: { name: "undici", version: "6.29.0" } };
    expect(collectEmbedded({ embedded: [undici], lockfile, readVendored: () => "x" }).errors).toEqual([]);
  });

  it("fails when the host moved to another version, because the embedded component may have changed", () => {
    const moved = { ...entry, host: { name: "@viz-js/viz", version: "3.31.0" } };
    expect(collectEmbedded({ embedded: [moved], lockfile, readVendored: () => "x" }).errors).toEqual([
      "embedded Graphviz 16.0.0 is recorded against @viz-js/viz@3.31.0, which pnpm-lock.yaml no longer resolves — re-check which version the host embeds and refresh the vendored text",
    ]);
  });
});

describe("renderNotices", () => {
  const npmEntries = [
    { name: "b-pkg", version: "1.0.0", license: "MIT", source: null, texts: [{ file: "LICENSE", text: MIT }] },
    { name: "a-pkg", version: "2.0.0", license: "MIT", source: null, texts: [{ file: "LICENSE", text: MIT }] },
    {
      name: "c-pkg",
      version: "3.0.0",
      license: "ISC",
      source: "https://example.test/c",
      texts: [{ file: "c.txt", text: "ISC text" }],
    },
  ];
  const embedded = [
    {
      component: "Graphviz",
      version: "16.0.0",
      license: "EPL-2.0",
      host: { name: "@viz-js/viz", version: "3.30.0" },
      source: "https://example.test/g",
      text: "EPL text",
    },
  ];
  const rust = collectRust(CARGO_ABOUT).groups;

  it("is identical whatever order the inputs arrive in", () => {
    const one = renderNotices({ rust, npm: npmEntries, embedded });
    const two = renderNotices({ rust: [...rust].reverse(), npm: [...npmEntries].reverse(), embedded });
    expect(two).toBe(one);
  });

  it("prints one block per distinct text, listing every package that shares it", () => {
    const out = renderNotices({ rust, npm: npmEntries, embedded });
    expect(out.match(/Permission is hereby granted\./g)).toHaveLength(1);
    expect(out).toContain("a-pkg 2.0.0 (MIT)\nb-pkg 1.0.0 (MIT)");
    expect(out).toContain("Source: https://example.test/c");
    expect(out).toContain("Graphviz 16.0.0 (EPL-2.0), compiled into @viz-js/viz 3.30.0");
    expect(out).toContain("alpha 1.2.3\nbeta 0.2.0");
    expect(out.endsWith("\n")).toBe(true);
    expect(out).not.toContain("\r");
  });

  it("states the counts in the header so an empty section is visible at a glance", () => {
    const out = renderNotices({ rust, npm: npmEntries, embedded });
    expect(out).toContain("Rust crates: 4");
    expect(out).toContain("npm packages: 3");
    expect(out).toContain("Embedded components: 1");
  });
});

describe("the release workflow", () => {
  const steps = parseYaml(readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf8")).jobs["build-tauri"].steps;
  const index = (name) => steps.findIndex((s) => s.name === name);

  it("regenerates the notices on every leg before the app is built", () => {
    const generate = index("Generate third-party notices");
    expect(generate, "release.yml must have a 'Generate third-party notices' step").toBeGreaterThan(-1);
    expect(steps[generate].run).toContain("node \"$GENERATOR\"");
    expect(steps[generate].run).toContain("GENERATOR=scripts/gen-third-party-licenses.mjs");
    expect(steps[generate].if, "generation must not be conditional on the platform").toBeUndefined();
    expect(index("Install cargo-about")).toBeGreaterThan(-1);
    expect(index("Install cargo-about")).toBeLessThan(generate);
    expect(index("Install frontend dependencies")).toBeLessThan(generate);
    expect(generate).toBeLessThan(index("Build Tauri app"));
  });

  it("installs the cargo-about version the generator was written against", () => {
    expect(steps[index("Install cargo-about")].with.tool).toBe("cargo-about@0.8.2");
  });

  it("checks the notices inside the built macOS bundle against the generated file", () => {
    const verify = steps[index("Verify bundled third-party notices (macOS)")];
    expect(verify, "release.yml must verify the bundled notices").toBeDefined();
    expect(verify.run).toContain(`Contents/Resources/resources/generated/THIRD_PARTY_LICENSES.txt`);
    expect(verify.run).toContain(`cmp "$BUNDLED" ${OUTPUT_REL}`);
    expect(index("Verify bundled third-party notices (macOS)")).toBeGreaterThan(index("Build Tauri app"));
  });
});

describe("this repository", () => {
  it("names the app crate it leaves out of the Rust half", () => {
    expect(appCrateName(REPO)).toBe("vmark");
  });

  it("vendored data names only files that exist and covers every package that ships no license", () => {
    const vendored = loadVendored(REPO);
    const packages = listNpmPackages(REPO);
    const result = collectNpm(npmCollectInputs(REPO, packages, vendored));
    expect(result.errors).toEqual([]);
    expect(result.entries.length).toBeGreaterThan(100);
    const embedded = collectEmbedded({
      embedded: vendored.embedded,
      lockfile: readFileSync(path.join(REPO, "pnpm-lock.yaml"), "utf8"),
      readVendored: npmCollectInputs(REPO, packages, vendored).readVendored,
    });
    expect(embedded.errors).toEqual([]);
  });
});
