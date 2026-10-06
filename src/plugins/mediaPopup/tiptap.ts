/**
 * Media Popup Tiptap Extension
 *
 * Purpose: Registers the MediaPopupView as a ProseMirror plugin view, connecting
 * the store-driven media popup to the editor lifecycle.
 *
 * @coordinates-with MediaPopupView.ts — DOM construction and behavior for the media popup
 * @coordinates-with plugins/shared/popupPorts.ts — the state PORT the host satisfies
 * @module plugins/mediaPopup/tiptap
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { StoreApi } from "zustand";
import type { MediaPopupState } from "@/plugins/shared/popupPorts";
import { MediaPopupView } from "./MediaPopupView";
import { requirePort } from "@/plugins/shared/requirePort";

const mediaPopupPluginKey = new PluginKey("mediaPopup");

class MediaPopupPluginView {
  private popupView: MediaPopupView;

  constructor(view: EditorView, store: StoreApi<MediaPopupState>) {
    this.popupView = new MediaPopupView(view, store);
  }

  update() {
    // No-op — popup updates via store subscription
  }

  destroy() {
    this.popupView.destroy();
  }
}

/** Tiptap extension that shows a popup when the cursor is on an audio/video node. */
export interface MediaPopupOptions {
  /** The popup state this plugin drives — a PORT, no default (ADR-015). */
  store: StoreApi<MediaPopupState> | undefined;
}

export const mediaPopupExtension = Extension.create<MediaPopupOptions>({
  name: "mediaPopup",
  addOptions() {
    return { store: undefined };
  },
  addProseMirrorPlugins() {
    const store = requirePort(this.options.store, "mediaPopupExtension", "store");
    return [
      new Plugin({
        key: mediaPopupPluginKey,
        view: (editorView) => new MediaPopupPluginView(editorView, store),
      }),
    ];
  },
});
