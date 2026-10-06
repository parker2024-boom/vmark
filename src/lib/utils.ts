/**
 * Shared UI helper module — holds the `cn()` class-name joiner.
 *
 * @module lib/utils
 */

/**
 * Utility for conditionally joining class names.
 * Simple alternative to clsx/classnames.
 */
export function cn(...inputs: (string | undefined | null | false)[]): string {
  return inputs.filter(Boolean).join(" ");
}
