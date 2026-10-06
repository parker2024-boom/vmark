/**
 * Translates one Markdown page: the system prompt, the Anthropic Messages API
 * call over fetch, and stripping a fence wrapped around the whole answer.
 *
 * @coordinates-with scripts/translate-docs.ts — the CLI that drives this module
 * @coordinates-with scripts/translate-docs/model.ts — languages and job shape
 * @module scripts/translate-docs/translateFile
 */
import fs from "node:fs";

import { LANGUAGES, type TranslationJob } from "./model.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 16000;

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(lang: string): string {
  const languageName = LANGUAGES[lang] ?? lang;
  return [
    `You are translating VMark documentation from English to ${languageName}.`,
    `VMark is a desktop Markdown editor built with Tauri and React.`,
    ``,
    `Rules:`,
    `- Translate prose text only`,
    `- Do NOT translate: code blocks, inline code, HTML tags, image paths, URLs`,
    `- Preserve all markdown syntax exactly (headings, lists, tables, links, emphasis)`,
    `- Preserve VitePress-specific syntax: :::tip, :::warning, :::info containers`,
    `- Preserve frontmatter YAML values (if any)`,
    `- Rewrite internal links: /guide/X → /${lang}/guide/X, /download → /${lang}/download`,
    `- External URLs (https://...) stay unchanged`,
    `- Keep the same line structure and paragraph breaks`,
    `- Translate naturally, not literally — use terminology common in ${languageName} tech documentation`,
    `- Output ONLY the translated markdown — no explanations, no markdown fences wrapping the whole document`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

async function callClaude(systemPrompt: string, content: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is not set.\n" +
        "Export it before running: export ANTHROPIC_API_KEY=sk-ant-..."
    );
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("Anthropic API returned no text content");
  }

  return textBlock.text.trim();
}

// ---------------------------------------------------------------------------
// Single file translation
// ---------------------------------------------------------------------------

export async function translateFile(job: TranslationJob): Promise<string> {
  const sourceContent = fs.readFileSync(job.sourcePath, "utf-8");
  const systemPrompt = buildSystemPrompt(job.lang);
  const userMessage = `Translate the following VitePress markdown documentation page to ${LANGUAGES[job.lang] ?? job.lang}:\n\n${sourceContent}`;

  const translated = await callClaude(systemPrompt, userMessage);

  // Strip wrapping markdown fences if Claude added them despite instructions
  const fenceMatch = translated.match(/^```(?:md|markdown)?\s*\n([\s\S]*?)```\s*$/);
  return fenceMatch ? fenceMatch[1].trim() + "\n" : translated + "\n";
}
