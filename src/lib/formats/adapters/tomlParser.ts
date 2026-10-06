/**
 * The TOML parser, loaded on first use.
 *
 * Purpose: keep smol-toml off the cold-start path. The format adapters are
 * registered in every window at startup, and a static import put the parser
 * in the entry chunk of every window, though only a TOML document needs it.
 * Here it is imported the first time a TOML document is validated, previewed
 * or opened in the source pane.
 *
 * Key decisions:
 *   - Synchronous callers (the Validator contract, schema detectors, render)
 *     ask `tomlParser()`, which answers null until the parser has arrived and
 *     starts loading it. While it loads they answer "nothing yet" — no
 *     findings, no schema, an empty preview — and `onTomlParserLoaded` tells
 *     them to ask again: the TOML format exposes it as
 *     `FormatConfig.validatorUpdates`, React renders read it through
 *     `useTomlParser`.
 *   - It fires once, when the parser arrives; a failed load is logged and
 *     retried on the next request instead of being cached as the answer.
 *
 * @coordinates-with toml.tsx — the validator, preview and format config
 * @coordinates-with cargoToml.tsx, pyprojectToml.tsx — the schema detector and renderers
 * @module lib/formats/adapters/tomlParser
 */
import { useEffect, useSyncExternalStore } from "react";
import { formatsWarn } from "@/utils/debug";

/** Parse TOML text; throws on a syntax error, as smol-toml's `parse` does. */
export type TomlParse = (text: string) => unknown;

let parse: TomlParse | null = null;
let loading: Promise<TomlParse> | null = null;
const listeners = new Set<() => void>();

/** Load the parser (once); resolves when it is ready. */
export function loadTomlParser(): Promise<TomlParse> {
  if (parse) return Promise.resolve(parse);
  loading ??= import("smol-toml").then(
    (module) => {
      parse = module.parse;
      for (const listener of [...listeners]) listener();
      return module.parse;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** The parser if it has loaded, else null — and it starts loading. */
export function tomlParser(): TomlParse | null {
  if (!parse) {
    loadTomlParser().catch((error: unknown) => formatsWarn("Failed to load the TOML parser:", error));
  }
  return parse;
}

/** Be told once the parser has loaded. Returns the unsubscribe. */
export function onTomlParserLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const loadedParser = (): TomlParse | null => parse;

/** The parser in a React render: null until it loads, then a re-render with it. */
export function useTomlParser(): TomlParse | null {
  useEffect(() => void tomlParser(), []);
  return useSyncExternalStore(onTomlParserLoaded, loadedParser);
}
