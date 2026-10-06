/**
 * The rules `scripts/check-commit-message.mjs` applies to a commit message:
 * the dump-shape thresholds, the ambient process variables, the vendor
 * credential patterns, the secret-name and placeholder tests, the published
 * documentation examples, and the randomness test `--strict-values` uses.
 *
 * Purpose: keep WHAT counts as a leak apart from how the gate reads the
 * message file, strips what git strips, and reports. Every value here is
 * data or a pure function of a string.
 *
 * @coordinates-with scripts/check-commit-message.mjs — applies these rules to the committed lines
 * @coordinates-with scripts/check-commit-message.test.mjs — the self-test
 * @module scripts/lib/commitMessageRules
 */

/** How many long line-start assignments constitute a dump. */
export const DUMP_LINE_THRESHOLD = 5;
/** Minimum value length for an assignment to look like dumped data rather than prose. */
export const MIN_DUMP_VALUE = 8;
/** How many distinct ambient process vars constitute a dump regardless of length. */
export const AMBIENT_THRESHOLD = 3;

/**
 * Variables that belong to a process environment and essentially never appear
 * WITH A VALUE in hand-written prose. Three of these together is a dump.
 */
export const AMBIENT_VARS = new Set([
  "PATH", "HOME", "SHELL", "PWD", "OLDPWD", "LOGNAME", "USER", "TMPDIR",
  "SSH_AUTH_SOCK", "TERM", "LANG", "SHLVL", "XPC_FLAGS", "XPC_SERVICE_NAME",
  "COMMAND_MODE", "INFOPATH", "MANPATH", "FPATH", "COLORTERM", "TERM_PROGRAM",
  "SECURITYSESSIONID", "LaunchInstanceID", "OSLogRateLimit", "GOPATH",
  "HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY", "BUN_INSTALL",
  "PNPM_HOME", "__CF_USER_TEXT_ENCODING", "__CFBundleIdentifier",
]);

/** Vendor credential shapes. Length bars are set so prose cannot reach them. */
export const CREDENTIAL_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key"],
  [/sk-ant-(?:api|oat)\d*-[A-Za-z0-9_-]{20,}/, "an Anthropic key"],
  [/sk-proj-[A-Za-z0-9_-]{20,}/, "an OpenAI project key"],
  [/sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/, "an OpenAI key"],
  [/github_pat_[A-Za-z0-9_]{40,}/, "a GitHub fine-grained token"],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, "a GitHub token"],
  [/glpat-[A-Za-z0-9_-]{20,}/, "a GitLab token"],
  [/npm_[A-Za-z0-9]{36,}/, "an npm token"],
  [/xai-[A-Za-z0-9]{40,}/, "an xAI key"],
  [/AIza[A-Za-z0-9_-]{35}/, "a Google API key"],
  [/hf_[A-Za-z0-9]{34,}/, "a Hugging Face token"],
  [/AKIA[0-9A-Z]{16}/, "an AWS access key id"],
  [/xox[baprs]-[A-Za-z0-9-]{20,}/, "a Slack token"],
  [/\bre_[A-Za-z0-9_]{24,}/, "a Resend key"],
];

/**
 * Variable-name fragments that make an assignment's value a credential.
 * Separators are `[-_]?` because the same name arrives as an env var
 * (`API_KEY`) and as a CLI flag (`--api-key`); matching only the underscore
 * spelling let `deploy --api-key=…` through.
 */
export const SECRET_NAME =
  /(?:PASS(?:WORD)?|SECRET|TOKEN|API[-_]?KEY|PRIVATE[-_]?KEY|ACCESS[-_]?KEY|CREDENTIAL)/i;

/** Values that are obviously stand-ins rather than live material. */
export const PLACEHOLDER =
  /^(?:[<{[].*[>}\]]|(.)\1{3,}|.*(?:your|example|placeholder|changeme|redacted|dummy|fake|sample).*)$/i;

/**
 * Credentials PUBLISHED as documentation examples. These match a real vendor
 * shape and are not secrets — AWS prints the first two in its own docs — so a
 * gate that flags them is wrong, not merely noisy.
 */
export const DOC_EXAMPLES = new Set([
  "AKIAIOSFODNN7EXAMPLE",
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "AKIAI44QH8DHBEXAMPLE",
]);

/** Shannon entropy in bits per character. */
function entropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Under `strictValues`, a secret-NAMED assignment must also look like random
 * material before it counts. Repos whose subject matter IS credentials — a
 * redactor, a key manager — legitimately write `client_secret=` and
 * `--password=` in prose, and flagging those trains the author to reach for
 * --no-verify, which is worse than no gate.
 *
 * Vendor patterns and the dump-shape rules are NOT relaxed by this: a real
 * environment dump still trips on its layout, which is what caught c506e3ff.
 */
export function looksRandom(value) {
  return (
    value.length >= 20 &&
    /[0-9]/.test(value) &&
    /[A-Za-z]/.test(value) &&
    entropy(value) >= 3.0
  );
}

/** Line-start assignment — the SHAPE of a dumped environment. */
export const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
/**
 * Assignment anywhere, value ending at whitespace — a pasted credential.
 * `-` is in the name class so a CLI flag (`--api-key=…`) is captured whole;
 * without it the capture starts after the hyphen and yields the harmless `key`.
 */
export const INLINE_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_-]*)=(\S{6,})/g;
