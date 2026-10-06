/**
 * Barrel for the link-create popup plugin — re-exports its Tiptap extension
 * and loads the popup's stylesheet.
 *
 * @module plugins/linkCreatePopup
 */

export { linkCreatePopupExtension } from "./tiptap";
import "./link-create-popup.css";
