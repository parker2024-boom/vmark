/**
 * Unified Diagram Cleanup Registry
 *
 * Single system for tracking destroy callbacks on diagram containers
 * (panzoom, export buttons, live D3/markmap instances). When ProseMirror
 * removes a widget, the DOM node is detached but document-level listeners
 * survive. This registry enables cleanup via two paths:
 *
 *   1. cleanupDescendants(parent) — explicit, before clearing innerHTML
 *   2. sweepDetached()           — periodic, in decoration rebuild
 *
 * All diagram types (mermaid, markmap, SVG) self-register here.
 *
 * Usage:
 *   registerCleanup(wrapper, panzoomInstance.destroy);
 *   registerCleanup(svgEl, () => mm.destroy());
 *
 * Then periodically (e.g. in the decoration rebuild):
 *   sweepDetached();
 *
 * @module plugins/shared/diagramCleanup
 */

const registry = new Map<Element, Set<() => void>>();

/** Register a cleanup callback for a container element. Deduplicates by reference. */
export function registerCleanup(container: Element, cleanup: () => void): void {
  const set = registry.get(container);
  if (set) {
    set.add(cleanup);
  } else {
    registry.set(container, new Set([cleanup]));
  }
}

/**
 * Run all cleanup callbacks for `parent` itself and any registered
 * descendants of `parent`, then remove them from the registry.
 * Call before clearing a container's innerHTML.
 */
export function cleanupDescendants(parent: Element): void {
  for (const [el, set] of registry) {
    if (el === parent || parent.contains(el)) {
      for (const fn of set) {
        try { fn(); } catch { /* already destroyed or DOM detached — safe to ignore */ }
      }
      registry.delete(el);
    }
  }
}

/** Dispose all elements whose DOM node has been detached from the document. */
export function sweepDetached(): void {
  for (const [el, set] of registry) {
    if (!el.isConnected) {
      for (const fn of set) {
        try { fn(); } catch { /* safe to ignore */ }
      }
      registry.delete(el);
    }
  }
}

/** Test helper: number of tracked elements. */
export function _registrySize(): number {
  return registry.size;
}

/** Test helper: clear registry without calling callbacks. */
export function _clearRegistry(): void {
  registry.clear();
}
