// VMark SessionStart hook: never emits model context; outside VMark, no-op.
const fs = require('node:fs');
const path = require('node:path');
const token = process.env.VMARK_TRANSCRIPT_TOKEN;
const root = __dirname;
// The one spelling VMark issues and reads back: lowercase, hyphenated 8-4-4-4-12.
const issued = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (!issued.test(token || '') || !fs.existsSync(path.join(root, 'enabled'))) process.exit(0);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 65536) process.exit(0); });
process.stdin.on('end', () => {
  try {
    const value = JSON.parse(input);
    if (value.hook_event_name !== 'SessionStart' || typeof value.transcript_path !== 'string' || !path.isAbsolute(value.transcript_path)) return;
    const dest = path.join(root, token + '.json');
    const tmp = dest + '.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ path: value.transcript_path, sessionId: value.session_id }), { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch { /* Preview must never prevent the CLI from starting. */ }
});
