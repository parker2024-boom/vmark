/**
 * Workspace index orchestrator (Phase 2).
 *
 * Composes walk → read → extract → resolve into a `WorkspaceIndex`: the doc
 * set, a bidirectional typed relationship graph, and a backlinks lookup.
 * Pure data — the HTTP layer (Phase 4) serves it; the watcher rebuilds
 * affected entries.
 *
 * @module index/buildIndex
 */

import { promises as fs } from "node:fs";
import { walkWorkspace, type WalkOptions } from "./walk";
import { extractRefs } from "./extract";
import { WikiResolver } from "./resolve";
import type {
  DocEntry,
  DocRefs,
  GraphEdge,
  GraphNode,
  RelationshipGraph,
} from "./types";

export interface WorkspaceIndex {
  root: string;
  docs: DocEntry[];
  refs: Map<string, DocRefs>;
  graph: RelationshipGraph;
  resolver: WikiResolver;
  truncated: boolean;
  /** relPath → list of source relPaths that link to it. */
  backlinks(relPath: string): string[];
}

export async function buildIndex(
  root: string,
  options: WalkOptions = {}
): Promise<WorkspaceIndex> {
  const { docs, truncated } = await walkWorkspace(root, options);
  const resolver = new WikiResolver(docs);
  const refs = new Map<string, DocRefs>();

  for (const doc of docs) {
    let content: string;
    try {
      content = await fs.readFile(doc.absPath, "utf8");
    } catch {
      refs.set(doc.relPath, emptyRefs());
      continue;
    }
    refs.set(doc.relPath, extractRefs(content));
  }

  const graph = buildGraph(docs, refs, resolver);
  const backlinkMap = buildBacklinkMap(graph);

  return {
    root,
    docs,
    refs,
    graph,
    resolver,
    truncated,
    backlinks: (relPath: string) => backlinkMap.get(relPath) ?? [],
  };
}

function emptyRefs(): DocRefs {
  return { wikiTargets: [], localLinks: [], tags: [], relations: {} };
}

/** Build the bidirectional typed graph from docs + their refs. */
function buildGraph(
  docs: DocEntry[],
  refs: Map<string, DocRefs>,
  resolver: WikiResolver
): RelationshipGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  const relByLower = new Map<string, string>(); // lower relpath → canonical
  for (const doc of docs) {
    relByLower.set(doc.relPath.toLowerCase(), doc.relPath);
    const r = refs.get(doc.relPath);
    nodes.set(doc.relPath, {
      id: doc.relPath,
      type: "doc",
      label: doc.basename,
      title: r?.title,
    });
  }

  const addEdge = (e: GraphEdge) => {
    const key = `${e.from}\u0000${e.to}\u0000${e.kind}\u0000${e.relationKey ?? ""}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push(e);
  };

  const ensureTagNode = (tag: string) => {
    const id = `#${tag}`;
    if (!nodes.has(id)) nodes.set(id, { id, type: "tag", label: `#${tag}` });
    return id;
  };

  const ensureUnresolved = (id: string) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, type: "doc", label: id, unresolved: true });
    }
  };

  for (const doc of docs) {
    const r = refs.get(doc.relPath);
    if (!r) continue;

    for (const raw of r.wikiTargets) {
      const { relPath } = resolver.resolve(raw, doc.relPath);
      if (relPath) {
        addEdge({ from: doc.relPath, to: relPath, kind: "wikiLink" });
      } else {
        const id = `[[${raw}]]`;
        ensureUnresolved(id);
        addEdge({ from: doc.relPath, to: id, kind: "wikiLink", unresolved: true });
      }
    }

    for (const href of r.localLinks) {
      const target = normalizeLocalLink(doc.relPath, href);
      if (target === null) continue; // escapes the workspace root → not an edge
      const canonical = relByLower.get(target.toLowerCase());
      if (canonical) {
        addEdge({ from: doc.relPath, to: canonical, kind: "link" });
      } else {
        ensureUnresolved(target);
        addEdge({ from: doc.relPath, to: target, kind: "link", unresolved: true });
      }
    }

    for (const tag of r.tags) {
      const id = ensureTagNode(tag);
      addEdge({ from: doc.relPath, to: id, kind: "tag" });
    }

    for (const [key, targets] of Object.entries(r.relations)) {
      for (const raw of targets) {
        const { relPath } = resolver.resolve(raw, doc.relPath);
        const to = relPath ?? `[[${raw}]]`;
        if (!relPath) ensureUnresolved(to);
        addEdge({ from: doc.relPath, to, kind: "relation", relationKey: key, unresolved: !relPath });
      }
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/** Map each doc to the source docs that point at it (link/wikiLink/relation). */
function buildBacklinkMap(graph: RelationshipGraph): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind === "tag") continue;
    if (e.unresolved) continue;
    const set = map.get(e.to) ?? new Set<string>();
    set.add(e.from);
    map.set(e.to, set);
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of map) out.set(k, [...v].sort());
  return out;
}

/** Resolve a relative markdown link against the source doc's directory. */
/**
 * Resolve a relative href against the source doc's dir. Returns null when the
 * path escapes above the workspace root (Codex audit: a `..` underflow must NOT
 * silently pop past root and re-map an external path back inside).
 */
function normalizeLocalLink(fromRelPath: string, href: string): string | null {
  const cleanHref = href.split("#")[0].split("?")[0];
  const fromDir = fromRelPath.includes("/")
    ? fromRelPath.slice(0, fromRelPath.lastIndexOf("/"))
    : "";
  const parts = (fromDir ? fromDir.split("/") : []).concat(cleanHref.split("/"));
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null; // escapes the workspace root
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/").normalize("NFC");
}
