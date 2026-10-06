/**
 * The link-create popup extension's wiring.
 *
 * The store arrives as an injected PORT (ADR-015), so this asserts the
 * extension threads it to the view, and that a host which forgets is told so
 * at wiring time rather than crashing inside the DOM code.
 *
 * @coordinates-with plugins/linkCreatePopup/tiptap.ts
 * @module plugins/linkCreatePopup/tiptap.test
 */
import { describe, it, expect, vi } from "vitest";

import { linkCreatePopupExtension } from "./tiptap";

function pluginFor(store: unknown) {
  const plugins = linkCreatePopupExtension.config.addProseMirrorPlugins!.call({
    name: "linkCreatePopup",
    options: { store },
    storage: {},
    parent: null as never,
    editor: {} as never,
    type: "extension" as never,
  } as never) as { spec: { view?: (v: unknown) => { destroy(): void } } }[];
  return plugins[0];
}

/** A store port that records who subscribed and whether they let go. */
function portStore() {
  const unsubscribe = vi.fn();
  return {
    getState: () => ({ isOpen: false, anchorRect: null }),
    subscribe: vi.fn(() => unsubscribe),
    unsubscribe,
  };
}

describe("the injected store reaches the view", () => {
  it("the real view subscribes to the option's store, not one it imported", () => {
    const store = portStore();
    pluginFor(store).spec.view!({ dom: document.createElement("div") } as never);
    expect(store.subscribe).toHaveBeenCalledTimes(1);
  });

  it("destroys the view with the editor, releasing the store", () => {
    const store = portStore();
    const handle = pluginFor(store).spec.view!({ dom: document.createElement("div") } as never);
    expect(store.unsubscribe).not.toHaveBeenCalled();
    handle.destroy();
    expect(store.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("tells a host that forgot the store, by name", () => {
    expect(() => pluginFor(undefined)).toThrow(/requires a `store` option/);
  });
});
