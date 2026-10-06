/**
 * Translates one locale file's content: the language names, the system prompt
 * for each format, and the validation of what comes back.
 *
 * @coordinates-with scripts/translate.ts — the CLI that drives this module
 * @coordinates-with scripts/translate/claude.ts — the API call
 * @module scripts/translate/translateContent
 */
import { callClaude } from "./claude.js";

// ---------------------------------------------------------------------------
// Language name map
// ---------------------------------------------------------------------------

const LANGUAGE_NAMES: Record<string, string> = {
  "zh-CN": "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  es: "Spanish (Español)",
  fr: "French (Français)",
  de: "German (Deutsch)",
  it: "Italian (Italiano)",
  "pt-BR": "Brazilian Portuguese (Português do Brasil)",
  ru: "Russian (Русский)",
  ar: "Arabic (العربية)",
  nl: "Dutch (Nederlands)",
  pl: "Polish (Polski)",
  tr: "Turkish (Türkçe)",
  vi: "Vietnamese (Tiếng Việt)",
  th: "Thai (ภาษาไทย)",
};

export function getLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

// ---------------------------------------------------------------------------
// JSON translation
// ---------------------------------------------------------------------------

function buildJsonSystemPrompt(lang: string): string {
  const langName = getLanguageName(lang);
  return [
    `You are an expert localizer for VMark — a desktop Markdown editor built with Tauri and React.`,
    ``,
    `Your task is to translate English UI strings into ${langName} (language code: ${lang}).`,
    ``,
    `Rules:`,
    `1. Preserve ALL {{variable}} placeholders exactly as-is (e.g. {{count}}, {{version}}, {{error}}).`,
    `2. Keep the JSON structure identical — same keys, same nesting.`,
    `3. Translate values only, never keys.`,
    `4. Keep translations concise — these are UI labels, not prose.`,
    `5. Use natural, idiomatic ${langName} appropriate for a desktop application.`,
    `6. Preserve any HTML entities (e.g. \\u2014, \\u2318) verbatim in the JSON string.`,
    `7. Do NOT add or remove any keys.`,
    `8. Output ONLY valid JSON — no markdown fences, no explanations, no trailing commas.`,
  ].join("\n");
}

export async function translateJsonContent(
  sourceContent: string,
  lang: string
): Promise<string> {
  const systemPrompt = buildJsonSystemPrompt(lang);
  const userMessage = `Translate the following JSON locale file into ${getLanguageName(lang)}:\n\n${sourceContent}`;

  const result = await callClaude(systemPrompt, userMessage);

  // Strip markdown code fences if Claude wrapped the output
  let cleaned = result;
  const fenceMatch = result.match(/^```(?:json)?\s*\n([\s\S]*?)```\s*$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Validate that the output is parseable JSON
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // Last resort: find the outermost JSON object in the response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        JSON.parse(jsonMatch[0]);
        return jsonMatch[0];
      } catch {
        // fall through to error
      }
    }
    throw new Error(
      `Claude returned invalid JSON for ${lang}. Response was:\n${result.slice(0, 500)}`
    );
  }
}

// ---------------------------------------------------------------------------
// YAML translation
// ---------------------------------------------------------------------------

function buildYamlSystemPrompt(lang: string): string {
  const langName = getLanguageName(lang);
  return [
    `You are an expert localizer for VMark — a desktop Markdown editor built with Tauri and React.`,
    ``,
    `Your task is to translate English UI strings in a YAML locale file into ${langName} (language code: ${lang}).`,
    ``,
    `Rules:`,
    `1. Preserve ALL YAML keys exactly — only translate the string values.`,
    `2. Keep the YAML structure (indentation, comments) identical.`,
    `3. Preserve any Unicode escape sequences and special characters verbatim.`,
    `4. Use natural, idiomatic ${langName} appropriate for a desktop application menu.`,
    `5. Keep translations concise — these are menu item labels.`,
    `6. Output ONLY the translated YAML — no markdown fences, no explanations.`,
    `7. Preserve all YAML comments (# ...) exactly as they appear.`,
  ].join("\n");
}

export async function translateYamlContent(
  sourceContent: string,
  lang: string
): Promise<string> {
  const systemPrompt = buildYamlSystemPrompt(lang);
  const userMessage = `Translate the following YAML locale file into ${getLanguageName(lang)}:\n\n${sourceContent}`;

  return await callClaude(systemPrompt, userMessage);
}
