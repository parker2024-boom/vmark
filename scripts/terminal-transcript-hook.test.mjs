// WI-TP1.1: hook handshake without touching real CLI configuration.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const token = 'cb28fc00-2c1b-4eaf-9d09-71d9d5392926';
test('SessionStart binds exactly, is silent, and ignores disabled/foreign invocations', () => {
  const root = mkdtempSync(join(tmpdir(), 'vmark-transcript-'));
  try {
    const script = join(root, 'terminal-transcript-hook.cjs');
    copyFileSync('src-tauri/resources/terminal-transcript-hook.cjs', script);
    const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'exact', transcript_path: '/tmp/exact.jsonl' });
    const run = (env = {}) => spawnSync(process.execPath, [script], { env: { ...process.env, ...env }, input, encoding: 'utf8' });
    const dest = join(root, token + '.json');
    assert.equal(run({ VMARK_TRANSCRIPT_TOKEN: token }).status, 0);
    assert.equal(existsSync(dest), false);
    writeFileSync(join(root, 'enabled'), 'enabled');
    assert.equal(run({ VMARK_TRANSCRIPT_TOKEN: '../invalid' }).status, 0);
    assert.equal(existsSync(dest), false);
    const result = run({ VMARK_TRANSCRIPT_TOKEN: token });
    assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(readFileSync(dest, 'utf8')), { path: '/tmp/exact.jsonl', sessionId: 'exact' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
// WI-RA7C.6 — the hook accepts a token only in the one spelling VMark issues and
// reads back (`valid_token` in terminal_transcript/mod.rs): lowercase,
// hyphenated 8-4-4-4-12. The loose `[a-f0-9-]{36}` it used accepted any other
// 36 characters from that alphabet and wrote a binding file Rust never opens.
test('a token in any other spelling writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'vmark-transcript-'));
  try {
    const script = join(root, 'terminal-transcript-hook.cjs');
    copyFileSync('src-tauri/resources/terminal-transcript-hook.cjs', script);
    writeFileSync(join(root, 'enabled'), 'enabled');
    const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', transcript_path: '/tmp/t.jsonl' });
    const refused = [
      token.toUpperCase(),
      '-'.repeat(36),
      'cb28fc002c1b4eaf9d0971d9d5392926aaaa',
      'cb28fc00-2c1b4-eaf-9d09-71d9d5392926',
      'cb28fc00-2c1b-4eaf-9d09-71d9d539292',
      token + '\n',
      '',
    ];
    for (const candidate of refused) {
      const result = spawnSync(process.execPath, [script], { env: { ...process.env, VMARK_TRANSCRIPT_TOKEN: candidate }, input, encoding: 'utf8' });
      assert.equal(result.status, 0, JSON.stringify(candidate));
      assert.deepEqual(readdirSync(root).sort(), ['enabled', 'terminal-transcript-hook.cjs'], JSON.stringify(candidate));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
