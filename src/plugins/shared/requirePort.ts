/**
 * Purpose: bind an injected PORT option, or fail at wiring time by name.
 *
 * Popup extensions receive the state they drive as a port the host injects
 * (ADR-015), and a port has no sensible default. The option is therefore
 * typed `| undefined` — honestly unbound until `configure()` supplies it —
 * and `requirePort` is the single place that turns "unbound" into a typed,
 * named error at plugin construction. A host that forgets a port learns
 * which extension and which option, instead of meeting `undefined is not an
 * object` from inside the popup's DOM code on first use.
 *
 * @coordinates-with services/assembly/tiptapExtensions.ts — the host that binds every port
 * @module plugins/shared/requirePort
 */

/** Thrown when an extension is built without a port its host must inject. */
export class UnboundPortError extends Error {
  readonly extension: string;
  readonly option: string;

  constructor(extension: string, option: string) {
    super(
      `${extension} requires a \`${option}\` option — the host must inject it; see services/assembly/tiptapExtensions.ts`
    );
    this.name = "UnboundPortError";
    this.extension = extension;
    this.option = option;
  }
}

/**
 * Return `port` when bound; throw `UnboundPortError` when it is absent.
 * Absent means `undefined` or `null` only — the check is about presence,
 * not truthiness.
 */
export function requirePort<T>(port: T | null | undefined, extension: string, option: string): T {
  if (port === undefined || port === null) throw new UnboundPortError(extension, option);
  return port;
}
