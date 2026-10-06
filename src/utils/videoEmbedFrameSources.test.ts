// @vitest-environment node
// WI-RA25.1 — the release CSP frames exactly the video embeds the app builds.
// The embed iframes point at the origins the provider registry declares; the
// CSP's `frame-src` in tauri.conf.json is a second, static copy of that list,
// and a release build enforces it. These tests read the real config, so the
// two cannot drift in either direction: an embed origin the CSP does not name
// is a blank frame in every shipped build, and an outside origin the CSP names
// but no embed uses is a frame a document could load for nothing.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  VIDEO_EMBED_ORIGINS,
  buildEmbedUrl,
  getProviderConfig,
  type VideoProvider,
} from "./videoProviderRegistry";

const TAURI_CONF = path.resolve(import.meta.dirname, "../../src-tauri/tauri.conf.json");

/** One valid video per provider. `Record` makes a new provider a type error here until it has one. */
const SAMPLE_VIDEO: Record<VideoProvider, { videoId: string; privacyHash: string | null }> = {
  youtube: { videoId: "dQw4w9WgXcQ", privacyHash: null },
  vimeo: { videoId: "76979871", privacyHash: "a1b2c3d4e5" },
  bilibili: { videoId: "BV1xx411c7mD", privacyHash: null },
};
const PROVIDERS = Object.keys(SAMPLE_VIDEO) as VideoProvider[];

function frameSources(): string[] {
  const config: unknown = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  const csp = (config as { app?: { security?: { csp?: unknown } } }).app?.security?.csp;
  if (typeof csp !== "string") throw new Error("tauri.conf.json app.security.csp is not a string");
  const directive = csp
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === "frame-src");
  if (!directive) throw new Error("the CSP names no frame-src");
  return directive.slice(1);
}

/**
 * The frame sources that are the app's own: its origin, the trusted HTML
 * preview's scheme, and that preview on platforms where custom protocols ride
 * on `http://<scheme>.localhost`. Everything else must be an embed origin.
 */
function isAppOwnFrameSource(source: string): boolean {
  if (source === "'self'") return true;
  if (/^[a-z][a-z0-9+.-]*:$/.test(source)) return true;
  return /^http:\/\/[a-z0-9-]+\.localhost$/.test(source);
}

describe("video embed origins", () => {
  it("every embed URL the builder emits points at its provider's declared origin", () => {
    for (const provider of PROVIDERS) {
      const { videoId, privacyHash } = SAMPLE_VIDEO[provider];
      const url = new URL(buildEmbedUrl(provider, videoId, { privacyHash }));
      expect(url.origin, provider).toBe(getProviderConfig(provider)?.embedOrigin);
      expect(url.protocol, provider).toBe("https:");
    }
  });

  it("lists one origin per provider and nothing else", () => {
    expect([...VIDEO_EMBED_ORIGINS].sort()).toEqual(
      PROVIDERS.map((provider) => getProviderConfig(provider)?.embedOrigin).sort(),
    );
  });

  it("uses YouTube's privacy-enhanced host, never youtube.com", () => {
    expect(VIDEO_EMBED_ORIGINS).toContain("https://www.youtube-nocookie.com");
    expect(VIDEO_EMBED_ORIGINS.some((origin) => /\/\/(www\.)?youtube\.com$/.test(origin))).toBe(false);
  });
});

describe("the release CSP frame-src", () => {
  it("names exactly the embed origins, besides the app's own frames", () => {
    const outside = frameSources().filter((source) => !isAppOwnFrameSource(source));
    expect([...outside].sort()).toEqual([...VIDEO_EMBED_ORIGINS].sort());
  });

  it("allows the frame of every embed the builder emits", () => {
    const sources = new Set(frameSources());
    for (const provider of PROVIDERS) {
      const { videoId, privacyHash } = SAMPLE_VIDEO[provider];
      const origin = new URL(buildEmbedUrl(provider, videoId, { privacyHash })).origin;
      expect(sources.has(origin), `${provider} embeds load from ${origin}`).toBe(true);
    }
  });

  it("keeps the app's own frames", () => {
    expect(frameSources()).toEqual(
      expect.arrayContaining(["'self'", "vmark-trusted:", "http://vmark-trusted.localhost"]),
    );
  });
});
