/**
 * Purpose: the transient notices a plugin asks the host to show.
 *
 * A plugin sometimes has to tell the user what it just did on their behalf —
 * "image not found, pasted as text" — or that an action they confirmed failed.
 * How a notice is presented (which toast library, how it waits out an IME
 * composition) is the app's business, so the plugin states the message and
 * its severity and the host presents it.
 *
 * Separate from `hostPopups`: those open a surface the user then works in;
 * a notice is fire-and-forget and carries only already-translated text.
 *
 * Defaults are NO-OPS, as for the rest of the host chrome: a plugin lifted out
 * of this repo still does its work, it just has nowhere to announce it.
 *
 * @coordinates-with services/assembly/bindHostSettings.ts — the app's binding
 * @module plugins/shared/hostNotify
 */

/** Notices a plugin can ask the host to present. Messages are already translated. */
export interface HostNotify {
  /** Something happened that the user should know about; nothing went wrong. */
  info: (message: string) => void;
  /** An action the user asked for failed. */
  error: (message: string) => void;
}

/** Nowhere to show a notice — the plugin's work is unaffected. */
const DEFAULTS: HostNotify = {
  info: () => {},
  error: () => {},
};

let bound: HostNotify = DEFAULTS;

/** Bind the host's notices. Called once, at app startup. */
export function bindHostNotify(notify: Partial<HostNotify>): void {
  bound = { ...DEFAULTS, ...notify };
}

/** Restore defaults. Tests only. */
export function resetHostNotify(): void {
  bound = DEFAULTS;
}

/** The bound notices, read through accessors so they are never captured stale. */
export const hostNotify: HostNotify = {
  info: (message) => bound.info(message),
  error: (message) => bound.error(message),
};
