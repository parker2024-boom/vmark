/**
 * Cross-platform Path Utilities
 *
 * Purpose: Simple path manipulation utilities that work with both Windows
 * (backslash) and POSIX (forward slash) paths without filesystem access.
 *
 * Note: For workspace boundary checks, prefer paths/paths.ts which normalizes
 * to forward slashes. This file is for display-oriented utilities (filenames,
 * the translation key of the file manager label — utils/ cannot translate).
 *
 * @coordinates-with paths/paths.ts — more comprehensive path utilities with normalization
 * @coordinates-with exportNaming.ts — uses getFileNameWithoutExtension for export filenames
 * @module utils/pathUtils
 */

/**
 * Extract the filename from a path (works for both Windows and POSIX).
 */
export function getFileName(filePath: string): string {
  // Handle both forward and back slashes
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
}

/**
 * Extract the filename without extension.
 */
export function getFileNameWithoutExtension(filePath: string): string {
  const name = getFileName(filePath);
  const lastDot = name.lastIndexOf(".");
  return lastDot > 0 ? name.slice(0, lastDot) : name;
}

/**
 * Get the directory part of a path (works for both Windows and POSIX).
 */
export function getDirectory(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  const dir = filePath.slice(0, lastSlash);
  if (/^[A-Za-z]:$/.test(dir)) return dir + "\\";
  return dir;
}

/**
 * Join directory and filename with appropriate separator.
 * Detects separator from directory path, defaults to forward slash.
 */
export function joinPath(directory: string, filename: string): string {
  if (!directory) return filename;
  const separator = directory.includes("\\") ? "\\" : "/";
  // Remove trailing separator if present
  const cleanDir = directory.endsWith(separator)
    ? directory.slice(0, -1)
    : directory;
  return `${cleanDir}${separator}${filename}`;
}

/** Translation key of a "reveal in file manager" label, namespace included. */
export type RevealInFileManagerKey =
  | "sidebar:contextMenu.revealInFinder"
  | "sidebar:contextMenu.showInExplorer"
  | "sidebar:contextMenu.showInFileManager";

/**
 * Platform-appropriate translation key for the "reveal in file manager"
 * action — Finder on macOS, Explorer on Windows, the file manager elsewhere.
 * Callers translate it; every menu that offers the action uses this one rule.
 */
export function revealInFileManagerKey(): RevealInFileManagerKey {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "sidebar:contextMenu.revealInFinder";
  if (platform.includes("win")) return "sidebar:contextMenu.showInExplorer";
  return "sidebar:contextMenu.showInFileManager";
}
