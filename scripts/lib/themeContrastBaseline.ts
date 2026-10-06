/**
 * The theme-contrast gate's finding and baseline shapes, the identity
 * comparison of findings against the baseline, and the D10 check that the
 * terminal's minimumContrastRatio default still backs the ANSI floors.
 *
 * @coordinates-with scripts/check-theme-contrast.ts — the gate, which re-exports these
 * @coordinates-with scripts/theme-contrast-baseline.json — the baseline
 * @module scripts/lib/themeContrastBaseline
 */

export interface ContrastFinding {
  theme: string;
  id: string;
  ratio: number;
  needed: number;
  message: string;
}

export interface ContrastBaseline {
  failing?: Record<string, string[]>;
  ansiFloor?: Record<string, { value: number; reason?: string }>;
  exempt?: Record<string, { id: string; reason?: string }[]>;
}

export function compareWithBaseline(
  findings: ContrastFinding[],
  baseline: ContrastBaseline,
  themeIds: string[],
): { newFindings: ContrastFinding[]; stale: { theme: string; id: string }[] } {
  const failing = baseline.failing ?? {};
  const newFindings = findings.filter((f) => !(failing[f.theme] ?? []).includes(f.id));
  const stale: { theme: string; id: string }[] = [];
  for (const [theme, ids] of Object.entries(failing)) {
    for (const id of ids) {
      const live = themeIds.includes(theme) && findings.some((f) => f.theme === theme && f.id === id);
      if (!live) stale.push({ theme, id });
    }
  }
  return { newFindings, stale };
}

/** D10: the ANSI floors assume xterm lifts foregrounds to ≥ 4.5 at paint time. */
export function checkMinimumContrastFloor(defaultsSource: string): string | null {
  const m = /minimumContrastRatio:\s*([\d.]+)/.exec(defaultsSource);
  if (!m) return "could not find minimumContrastRatio in src/stores/settingsStore/defaults.ts — the ANSI floors rest on it (D10).";
  if (Number(m[1]) < 4.5) {
    return `minimumContrastRatio default is ${m[1]} but the ANSI floors in theme-contrast-baseline.json assume >= 4.5 (D10).`;
  }
  return null;
}
