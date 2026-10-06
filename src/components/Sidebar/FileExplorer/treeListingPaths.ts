/**
 * Tree listing paths — rebuild each node's absolute path from the wire form.
 *
 * Purpose: `list_directory_tree` sends the root once (as the prefix its
 *   top-level children's paths start with) and only a name per node, so a
 *   20k-node workspace does not repeat its root path 20k times over IPC. This
 *   turns that wire form back into the `TreeListing` the explorer works with,
 *   every node carrying its absolute path.
 *
 * Key decisions:
 *   - The paths are rebuilt EXACTLY as the Rust walker's `Path::join` spells
 *     them: a top-level child is `rootPrefix + name` (the prefix already ends
 *     however `join` ends the root — "/" for a filesystem root, a backslash on
 *     Windows), and a nested child is `parent + separator + name`. Node ids are
 *     compared with open documents' paths, so a respelled path would be a
 *     different file to the explorer.
 *   - A payload without the prefix or the separator is a contract break and
 *     throws, which the explorer reports as a failed listing.
 *
 * @coordinates-with src-tauri/src/files/tree_walk.rs — produces the wire form
 * @coordinates-with useFileTree.ts — sole caller
 * @module components/Sidebar/FileExplorer/treeListingPaths
 */
import type { TreeEntry, TreeListing } from "./types";

/** One node as the walker sends it: its name, never its path. */
interface WireTreeEntry {
  name: string;
  isDirectory: boolean;
  isHidden: boolean;
  unreadable?: boolean;
  children?: WireTreeEntry[];
}

/** The listing as the walker sends it. */
export interface WireTreeListing {
  /** What every top-level child's path starts with (the root plus its separator). */
  rootPrefix: string;
  /** The separator the walker joins a directory and a child name with. */
  separator: string;
  entries: WireTreeEntry[];
  truncated: boolean;
}

function withPaths(entries: WireTreeEntry[], prefix: string, separator: string): TreeEntry[] {
  return entries.map((entry) => {
    const path = prefix + entry.name;
    const { children, ...rest } = entry;
    return children === undefined
      ? { ...rest, path }
      : { ...rest, path, children: withPaths(children, path + separator, separator) };
  });
}

/** The listing with every node's absolute path filled in. Throws on a malformed payload. */
export function withAbsolutePaths(listing: WireTreeListing): TreeListing {
  if (
    !listing ||
    typeof listing.rootPrefix !== "string" ||
    typeof listing.separator !== "string" ||
    !Array.isArray(listing.entries)
  ) {
    throw new Error("malformed tree listing: missing rootPrefix, separator or entries");
  }
  return {
    entries: withPaths(listing.entries, listing.rootPrefix, listing.separator),
    truncated: listing.truncated,
  };
}
