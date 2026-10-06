/**
 * Purpose: turn a shortcut-import problem code into a sentence in the UI
 * language. The shortcuts store reports codes because a store has no `t()`;
 * the settings page, which shows them, translates them here.
 *
 * Each code has the key `settings:shortcuts.importError.<code>`, and the
 * error's own fields (`id`, `detail`) are its parameters. The key is built
 * from the code rather than listed: this page has a byte budget, and
 * ShortcutsSettings.importI18n.test.tsx drives every code through the page
 * and checks each key in every locale.
 *
 * @coordinates-with stores/settingsStore/shortcuts.ts — ShortcutImportError
 * @coordinates-with ShortcutsSettings.tsx — the import toast
 * @module pages/settings/shortcutImportErrors
 */
import i18n from "@/i18n";
import type { ShortcutImportError } from "@/stores/settingsStore/shortcuts";

/** One translated line for one import problem. */
export const describeShortcutImportError = (error: ShortcutImportError): string =>
  i18n.t(`settings:shortcuts.importError.${error.code}`, error);
