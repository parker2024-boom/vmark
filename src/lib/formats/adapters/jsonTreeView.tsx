/**
 * The tree a structured-data preview draws (JSON, TOML, YAML): react-json-view-lite
 * with its stylesheet and VMark's token-aligned styles.
 *
 * Loaded on demand through `LazyJsonTree`. The format adapters that show it are
 * registered in every window at startup, so a static import put the library on
 * every window's cold start — Settings and PDF export included — although it is
 * needed only once a preview pane opens.
 *
 * @coordinates-with lib/formats/adapters/LazyJsonTree.tsx — the loader
 * @coordinates-with lib/formats/adapters/jsonViewStyles.ts — the styles
 * @module lib/formats/adapters/jsonTreeView
 */
import { JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { useIsDarkTheme } from "@/hooks/useIsDarkTheme";
import { jsonViewStyles } from "./jsonViewStyles";

/** Props of the tree: the parsed value to draw. */
export interface JsonTreeViewProps {
  data: unknown;
}

/** The parsed value as a collapsible tree, styled for the current theme. */
export default function JsonTreeView({ data }: JsonTreeViewProps) {
  const isDark = useIsDarkTheme();
  return <JsonView data={data as object} style={jsonViewStyles(isDark)} />;
}
