/**
 * Registered fragments: wordless placeholder strings that are only correct
 * appended to a sentence, the files allowed to use each, and the key matching
 * both fragment checks share.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate CLI that runs this check
 * @coordinates-with scripts/i18n-keys/fragmentUsage.ts — the JSX walk over these registrations
 * @module scripts/i18n-keys/fragments
 */
import ts from "typescript";

/**
 * Strings that are only placeholders and punctuation — "({{line}}:{{column}})"
 * — are FRAGMENTS: correct appended to a sentence, meaningless alone (it
 * rendered as a red "(6:1)" strip). Each must be registered with where it is
 * meant to appear, so using one alone is a decision someone wrote down.
 */
export interface FragmentRegistration {
  /** Where the fragment is meant to appear. */
  readonly where: string;
  /** Every source file allowed to use it — each use is a reviewed decision. */
  readonly files: readonly string[];
}

export const REGISTERED_FRAGMENTS: Readonly<Record<string, FragmentRegistration>> = {
  "editor.json:preview.errorAt": {
    where: "suffix after preview.cannotRender / preview.workflowParseFailed",
    files: [
      "src/lib/formats/adapters/cargoToml.tsx",
      "src/lib/formats/adapters/json.tsx",
      "src/lib/formats/adapters/mermaid.tsx",
      "src/lib/formats/adapters/packageJson.tsx",
      "src/lib/formats/adapters/pyprojectToml.tsx",
      "src/lib/formats/adapters/svg.tsx",
      "src/lib/formats/adapters/toml.tsx",
      "src/lib/formats/adapters/yaml.tsx",
      "src/lib/formats/adapters/yamlWorkflowRenderer.tsx",
    ],
  },
  "statusbar.json:terminal.search.results": {
    where: "match counter beside the terminal search field",
    files: ["src/components/Terminal/TerminalSearchBar.tsx"],
  },
  "dialog.json:exportError.listItem": {
    where: "the language's quote marks around one entry of an export-error list",
    files: ["src/export/exportErrorMessages.ts"],
  },
};

/** Keys of `values` that are wordless placeholder strings not in `fragments`. */
export function standaloneTextFindings(
  values: Readonly<Record<string, string>>,
  fragments: Readonly<Record<string, unknown>>,
): string[] {
  return Object.entries(values)
    .filter(([key, value]) => {
      if (!value.includes("{{") || key in fragments) return false;
      return !/\p{L}/u.test(value.replace(/\{\{[^}]*\}\}/g, ""));
    })
    .map(([key]) => key);
}

/** Inline wrappers a fragment may sit in and still belong to its sentence. */
export const INLINE_TAGS = new Set([
  ...["span", "strong", "em", "b", "i", "u", "s", "code", "small", "mark", "bdi", "bdo"],
  ...["a", "abbr", "cite", "q", "sub", "sup", "time", "label"],
]);

/** JSX attributes whose value is never displayed. */
export const NON_DISPLAY_ATTRIBUTE = /^(?:data-|key$|id$|className$|style$|ref$|htmlFor$|name$|type$|role$|tabIndex$|testid$)/;

/** `{ns, key}` of a registered fragment id `editor.json:preview.errorAt`. */
export function fragmentRefs(fragments: Readonly<Record<string, unknown>>) {
  return Object.keys(fragments).map((id) => {
    const [file, key] = id.split(/:(.*)/s);
    return { ns: file.replace(/\.json$/, ""), key };
  });
}

/** The fragment a string key names, honouring an explicit `ns:` prefix. */
export function matchFragment(raw: string, refs: readonly { ns: string; key: string }[]) {
  const colon = raw.indexOf(":");
  const ns = colon === -1 ? null : raw.slice(0, colon);
  const key = colon === -1 ? raw : raw.slice(colon + 1);
  return refs.find((r) => r.key === key && (ns === null || ns === r.ns)) ?? null;
}

/**
 * Each registered fragment is used ONLY in the files its registration lists:
 * a use anywhere else — through a variable, a toast, a `.ts` helper, a key
 * held in a constant — is a new decision about where the fragment appears,
 * which the JSX walk above cannot follow. Exact, not heuristic: any string
 * literal naming the key counts (namespace-aware). A listed file that stopped
 * using the fragment is stale.
 */
export function fragmentSiteFindings(
  files: Readonly<Record<string, string>>,
  registry: Readonly<Record<string, FragmentRegistration>>,
): string[] {
  const out: string[] = [];
  for (const [id, registration] of Object.entries(registry)) {
    const refs = fragmentRefs({ [id]: registration });
    const [{ key }] = refs;
    const users = Object.entries(files)
      .filter(([rel, text]) => {
        // Cheap prefilter; an escaped spelling ("\u0065rrorAt") is decoded
        // by the parser, so a file with escapes is always parsed.
        if (!text.includes(key) && !/\\[ux]/.test(text)) return false;
        const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
        let found = false;
        const visit = (node: ts.Node) => {
          if (found) return;
          if (ts.isStringLiteralLike(node) && matchFragment(node.text, refs)) found = true;
          else ts.forEachChild(node, visit);
        };
        visit(sf);
        return found;
      })
      .map(([rel]) => rel);
    for (const rel of users.filter((u) => !registration.files.includes(u))) {
      out.push(`${rel}: uses fragment ${key}, but its registration does not list this file`);
    }
    for (const rel of registration.files.filter((f) => f in files && !users.includes(f))) {
      out.push(`${rel}: registered for fragment ${key} but no longer uses it — delete it from the registration`);
    }
    for (const rel of registration.files.filter((f) => !(f in files))) {
      out.push(`${rel}: registered for fragment ${key} but does not exist — delete it from the registration`);
    }
  }
  return out;
}
