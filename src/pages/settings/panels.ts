/**
 * Settings panel registry.
 *
 * Purpose: single source of truth for which component renders each settings
 * section. Both the normal single-panel view and the search view (which stacks
 * every searchable panel) read from here, so the two never drift.
 *
 * Key decisions:
 *   - A section names the IMPORT of its panel, not the panel. The Settings
 *     window opens on one section; importing all eleven statically made it
 *     evaluate every panel before it could paint the first. Each loads when
 *     its section is first shown, or when search needs it.
 *
 * @coordinates-with pages/settings/panelCache.ts — the loading and its memory
 * @coordinates-with pages/settings/SettingsContent.tsx — renders the panels
 * @module pages/settings/panels
 */

import type { ComponentType } from "react";
import { createPanelCache } from "./panelCache";

export type Section =
  | "about"
  | "appearance"
  | "editor"
  | "files"
  | "formats"
  | "integrations"
  | "language"
  | "markdown"
  | "shortcuts"
  | "terminal"
  | "advanced";

/** Section id → the import of its panel. */
const SETTINGS_PANEL_LOADERS: Record<Section, () => Promise<ComponentType>> = {
  appearance: () => import("./AppearanceSettings").then((m) => m.AppearanceSettings),
  editor: () => import("./EditorSettings").then((m) => m.EditorSettings),
  files: () => import("./FilesImagesSettings").then((m) => m.FilesImagesSettings),
  formats: () => import("./FormatsSettings").then((m) => m.FormatsSettings),
  integrations: () => import("./IntegrationsSettings").then((m) => m.IntegrationsSettings),
  language: () => import("./LanguageSettings").then((m) => m.LanguageSettings),
  markdown: () => import("./MarkdownSettings").then((m) => m.MarkdownSettings),
  shortcuts: () => import("./ShortcutsSettings").then((m) => m.ShortcutsSettings),
  terminal: () => import("./TerminalSettings").then((m) => m.TerminalSettings),
  about: () => import("./AboutSettings").then((m) => m.AboutSettings),
  advanced: () => import("./AdvancedSettings").then((m) => m.AdvancedSettings),
};

/** The settings panels, each loaded the first time something shows it. */
export const settingsPanels = createPanelCache("Settings", SETTINGS_PANEL_LOADERS);

/**
 * Panels included in global search, in display order. Shortcuts is excluded:
 * it has its own dedicated search and is keybindings, not SettingRow-based
 * settings. `advanced` is appended by the caller only when the dev section is
 * visible.
 */
export const SEARCHABLE_PANEL_IDS: Section[] = [
  "appearance",
  "editor",
  "files",
  "formats",
  "integrations",
  "language",
  "markdown",
  "terminal",
  "about",
];
