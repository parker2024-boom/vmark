/**
 * Markmap Export
 *
 * Adds a PNG export button to markmap mindmap containers.
 * Renders SVG with the chosen theme, converts to 2x PNG, and saves via Tauri dialog.
 *
 * @module plugins/markmap/markmapExport
 */

import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { renderMarkmapToSvgString } from "./index";
import { svgToPngBytes } from "@/utils/svgToPng";
import { diagramWarn } from "@/utils/debug";
import {
  setupDiagramExport,
  LIGHT_BG,
  DARK_BG,
  type ExportInstance,
} from "@/plugins/shared/diagramExport";

export function setupMarkmapExport(
  container: HTMLElement,
  markmapSource: string,
): ExportInstance {
  return setupDiagramExport(container, async (theme) => {
    const svg = await renderMarkmapToSvgString(markmapSource, theme);
    if (!svg) {
      diagramWarn("render returned no SVG");
      return;
    }

    const bgColor = theme === "dark" ? DARK_BG : LIGHT_BG;

    let pngData: Uint8Array;
    try {
      pngData = await svgToPngBytes(svg, 2, bgColor);
    } catch (e) {
      diagramWarn("SVG->PNG conversion failed", e);
      return;
    }

    const filePath = await save({
      defaultPath: "mindmap.png",
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    if (!filePath) return;

    try {
      await writeFile(filePath, pngData);
    } catch (e) {
      diagramWarn("failed to write file", e);
    }
  });
}
