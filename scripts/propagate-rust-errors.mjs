#!/usr/bin/env node
/**
 * Propagate the `errors:` namespace from src-tauri/locales/en.yml to all other
 * locale YAMLs. Each locale's translated block is a module under
 * scripts/lib/rustErrorBlocks/; a locale whose YAML already has an `errors:`
 * section, or that has no block, is skipped with a message.
 *
 * Treats the YAML files as text (preserves comments and ordering) because the
 * rust-i18n format uses dotted flat keys at the second level, which is trivial
 * to append.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ERRORS as zhCN } from "./lib/rustErrorBlocks/zh-CN.mjs";
import { ERRORS as zhTW } from "./lib/rustErrorBlocks/zh-TW.mjs";
import { ERRORS as ja } from "./lib/rustErrorBlocks/ja.mjs";
import { ERRORS as ko } from "./lib/rustErrorBlocks/ko.mjs";
import { ERRORS as de } from "./lib/rustErrorBlocks/de.mjs";
import { ERRORS as es } from "./lib/rustErrorBlocks/es.mjs";
import { ERRORS as fr } from "./lib/rustErrorBlocks/fr.mjs";
import { ERRORS as it } from "./lib/rustErrorBlocks/it.mjs";
import { ERRORS as ptBR } from "./lib/rustErrorBlocks/pt-BR.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LOCALES_DIR = resolve(ROOT, "src-tauri/locales");

const LOCALES = ["zh-CN", "zh-TW", "ja", "ko", "de", "es", "fr", "it", "pt-BR"];

// Full errors block per locale, one module each under scripts/lib/rustErrorBlocks/.
// %{name} placeholders must match en.yml verbatim.
const ERRORS_BY_LOCALE = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  "ja": ja,
  "ko": ko,
  "de": de,
  "es": es,
  "fr": fr,
  "it": it,
  "pt-BR": ptBR,
};

for (const locale of LOCALES) {
  const filePath = resolve(LOCALES_DIR, `${locale}.yml`);
  const current = readFileSync(filePath, "utf-8");
  if (current.includes("\nerrors:")) {
    console.log(`${locale}.yml already has errors section — skipping`);
    continue;
  }
  const block = ERRORS_BY_LOCALE[locale];
  if (!block) {
    console.warn(`No translation block defined for ${locale} — skipping`);
    continue;
  }
  writeFileSync(filePath, current.trimEnd() + "\n" + block);
  console.log(`Updated ${locale}.yml`);
}

console.log("Done.");
