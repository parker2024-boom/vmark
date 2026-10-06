/**
 * One Anthropic Messages API call over fetch (no SDK), returning the text block.
 *
 * @coordinates-with scripts/translate.ts — the CLI that drives this module
 * @module scripts/translate/claude
 */

// ---------------------------------------------------------------------------
// Anthropic API (fetch-based — no SDK required)
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5"; // Reliable for structured JSON output

export async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
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
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
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
