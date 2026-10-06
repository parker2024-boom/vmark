// WI-RA17F.7 — an unbound popup port fails at wiring time, by name, as a typed error.
/**
 * The popup extensions take their state as an injected PORT with no default
 * (ADR-015). Their defaults used to be `undefined` cast to the store type, so
 * the type said "always bound" while the value said otherwise, and each
 * extension hand-rolled its own guard and message. This pins the shared
 * contract: every port option, left unbound, throws `UnboundPortError` naming
 * the extension and the option — at plugin construction, not inside the DOM
 * code later.
 *
 * Here, beside the host that binds the ports, because a test under
 * plugins/shared may not import the feature plugins (plugin-isolation).
 *
 * @coordinates-with plugins/shared/requirePort.ts
 * @coordinates-with services/assembly/tiptapExtensions.ts
 * @module services/assembly/popupPortBinding.test
 */
import { describe, it, expect } from "vitest";
import { UnboundPortError } from "@/plugins/shared/requirePort";
import { footnotePopupExtension } from "@/plugins/footnotePopup/tiptap";
import { linkCreatePopupExtension } from "@/plugins/linkCreatePopup/tiptap";
import { linkPopupExtension } from "@/plugins/linkPopup/tiptap";
import { mathPopupExtension } from "@/plugins/mathPopup/tiptap";
import { mediaPopupExtension } from "@/plugins/mediaPopup/tiptap";
import { wikiLinkPopupExtension } from "@/plugins/wikiLinkPopup/tiptap";

/** A stand-in store: plugin construction must not touch it. */
const boundStore = { getState: () => ({}), setState: () => {}, subscribe: () => () => {} };

/** The slice of a Tiptap extension these tests drive, independent of its options type. */
interface PortExtension {
  name: string;
  config: { addOptions?: () => unknown; addProseMirrorPlugins?: () => unknown };
}

function buildPlugins(extension: PortExtension, options: Record<string, unknown>) {
  return extension.config.addProseMirrorPlugins!.call({
    name: extension.name,
    options,
    storage: {},
    parent: null as never,
    editor: {} as never,
    type: "extension" as never,
  } as never);
}

/** Every port option of every popup extension, and the options that accompany it. */
const PORTS: [string, string, PortExtension, Record<string, unknown>][] = [
  ["footnotePopupExtension", "store", footnotePopupExtension, {}],
  ["linkCreatePopupExtension", "store", linkCreatePopupExtension, {}],
  ["linkPopupExtension", "store", linkPopupExtension, { createStore: boundStore }],
  ["linkPopupExtension", "createStore", linkPopupExtension, { store: boundStore }],
  ["mathPopupExtension", "store", mathPopupExtension, {}],
  ["mediaPopupExtension", "store", mediaPopupExtension, {}],
  ["wikiLinkPopupExtension", "store", wikiLinkPopupExtension, {}],
];

describe("popup extensions with an unbound port", () => {
  it.each(PORTS)("%s rejects a missing `%s`", (extensionName, option, extension, others) => {
    let caught: unknown;
    try {
      buildPlugins(extension, { ...others, [option]: undefined });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnboundPortError);
    expect((caught as UnboundPortError).extension).toBe(extensionName);
    expect((caught as UnboundPortError).option).toBe(option);
  });

  it.each(PORTS)("%s builds when `%s` is bound", (_name, option, extension, others) => {
    const plugins = buildPlugins(extension, { ...others, [option]: boundStore });
    expect(Array.isArray(plugins) && plugins.length > 0).toBe(true);
  });

  it("each extension's default leaves its ports unbound rather than faking a store", () => {
    for (const [, option, extension] of PORTS) {
      const defaults = extension.config.addOptions!.call({ name: extension.name, parent: undefined } as never) as Record<string, unknown>;
      expect(defaults[option]).toBeUndefined();
    }
  });
});
