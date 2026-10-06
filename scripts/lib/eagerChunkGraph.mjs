/**
 * The built bundle as a graph: which assets `dist/index.html` loads eagerly,
 * which sibling chunks each built chunk imports statically, and the static
 * closure from a set of seeds with the shortest import chain to each chunk.
 *
 * Purpose: the parsing and graph-walking half of the eager-chunk gate. Which
 * chunks must stay off that closure, and the byte budget, are policy and live
 * in the gate; why the walk starts from the boot chunks as well as the HTML is
 * in the gate's header.
 *
 * @coordinates-with scripts/check-eager-chunks.mjs — the gate (CLI) that re-exports this
 * @module scripts/lib/eagerChunkGraph
 */

/**
 * Parse one HTML tag's attributes into a lowercase-keyed map.
 * Handles double-quoted, single-quoted, and unquoted values in any order.
 */
function parseAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const m of tag.matchAll(re)) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  }
  return attrs;
}

/** True when a rel attribute's space-separated token list contains `token`. */
function relContains(rel, token) {
  return (rel ?? "").toLowerCase().split(/\s+/).includes(token);
}

/**
 * Collect every asset URL the document loads eagerly at cold start:
 * modulepreload link hrefs first, then script srcs (matches the original
 * reporting order).
 */
export function collectEagerAssets(html) {
  const preloads = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag);
    if (relContains(attrs.rel, "modulepreload") && attrs.href) {
      preloads.push(attrs.href);
    }
  }
  const scripts = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag);
    if (attrs.src) scripts.push(attrs.src);
  }
  return [...preloads, ...scripts];
}

/**
 * Sibling chunk files a built chunk imports STATICALLY.
 *
 * Rolldown emits dynamic imports as `import(`./x.js`)` and static ones as
 * `import … from "./x.js"` / `import "./x.js"` / `export … from "./x.js"`.
 * Rather than trying to match every static form, count each specifier's
 * occurrences and subtract the ones sitting inside `import(...)`: a specifier
 * left with a positive count has at least one static edge. Under-counting is
 * the safe direction only for false NEGATIVES, so the subtraction is per
 * specifier, not a set difference — a chunk imported both ways still counts.
 */
export function staticImportsOf(code) {
  const counts = new Map();
  for (const m of code.matchAll(/(['"`])(\.\/[^'"`\s]+\.js)\1/g)) {
    counts.set(m[2], (counts.get(m[2]) ?? 0) + 1);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*(['"`])(\.\/[^'"`\s]+\.js)\1\s*\)/g)) {
    counts.set(m[2], (counts.get(m[2]) ?? 0) - 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 0).map(([spec]) => spec.slice(2));
}

/** Build `chunk name → statically imported chunk names` from `[name, code]` pairs. */
export function buildStaticGraph(entries) {
  return new Map(entries.map(([name, code]) => [name, staticImportsOf(code)]));
}

/**
 * Breadth-first static closure from `seeds`, remembering the shortest path to
 * each reachable chunk so a failure can name the import chain, not just the
 * offender. Unknown seeds are ignored (a hashed asset may be a stylesheet).
 */
export function staticClosurePaths(seeds, graph) {
  const paths = new Map();
  const queue = [];
  for (const seed of seeds) {
    if (graph.has(seed) && !paths.has(seed)) {
      paths.set(seed, [seed]);
      queue.push(seed);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of graph.get(current) ?? []) {
      if (paths.has(next)) continue;
      paths.set(next, [...paths.get(current), next]);
      queue.push(next);
    }
  }
  return paths;
}
