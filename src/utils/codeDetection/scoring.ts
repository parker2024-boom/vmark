/**
 * Code Detection Scoring
 *
 * Functions to calculate how "code-like" text appears to be.
 *
 * @module utils/codeDetection/scoring
 */

import {
  LANGUAGE_PATTERNS,
  GENERIC_CODE_PATTERNS,
  NON_CODE_PATTERNS,
} from "./patterns";

/**
 * Calculate a score for how "code-like" the text is.
 */
export function calculateCodeScore(text: string): number {
  let score = 0;
  const lines = text.split("\n");

  // Check for consistent indentation
  const indentedLines = lines.filter((line) => /^(\s{2,}|\t)\S/.test(line));
  if (indentedLines.length > lines.length * 0.3) {
    score += 3;
  }

  // Check generic code patterns
  for (const pattern of GENERIC_CODE_PATTERNS) {
    if (pattern.test(text)) {
      score += 1;
    }
  }

  // Check non-code patterns (reduce score)
  for (const pattern of NON_CODE_PATTERNS) {
    if (pattern.test(text)) {
      score -= 2;
    }
  }

  // High ratio of special characters to letters
  const specialChars = (text.match(/[{}()[\];:=<>+\-*/%&|!?]/g) || []).length;
  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  if (letters > 0 && specialChars / letters > 0.1) {
    score += 2;
  }

  // Multiple lines with similar structure
  if (lines.length > 2) {
    const indentPattern = lines.slice(0, 5).map((l) => l.match(/^(\s*)/)?.[1]?.length || 0);
    const hasConsistentIndent = indentPattern.some((indent, i, arr) =>
      i > 0 && indent === arr[i - 1] && indent > 0
    );
    if (hasConsistentIndent) {
      score += 2;
    }
  }

  return score;
}

/**
 * Detect the likely programming language of the code.
 */
export function detectLanguage(text: string): { language: string | null; score: number } {
  let bestMatch: { language: string | null; score: number } = { language: null, score: 0 };

  for (const [lang, { keywords, patterns }] of Object.entries(LANGUAGE_PATTERNS)) {
    let langScore = 0;

    // Check keywords (higher weight)
    for (const pattern of keywords) {
      const matches = text.match(new RegExp(pattern, "gm"));
      if (matches) {
        langScore += matches.length * 2;
      }
    }

    // Check patterns
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        langScore += 3;
      }
    }

    if (langScore > bestMatch.score) {
      bestMatch = { language: lang, score: langScore };
    }
  }

  return bestMatch;
}
