/**
 * ESLint rule `vmark/require-disable-reason`: every disable directive says why.
 *
 * A suppression is a claim that a rule is wrong AT THIS SITE. Written bare
 * (`// eslint-disable-next-line react-hooks/exhaustive-deps`) the claim
 * cannot be checked: a reader cannot tell a considered exception from a
 * silenced warning, and when the code under it changes nothing says whether
 * the exception still holds. ESLint's own description syntax carries the
 * reason on the directive itself — `-- <reason>` after the rule list — so it
 * travels with the suppression through every move and edit.
 *
 * Reports `eslint-disable`, `eslint-disable-line` and
 * `eslint-disable-next-line` directives, in line or block comments, whose
 * description is missing or blank. `eslint-enable` is exempt: it suppresses
 * nothing. The separator is ESLint's own: two or more dashes with whitespace
 * on both sides, so `rule--x` is a rule name, not a description.
 *
 * A blanket `eslint-disable` with no rule list suppresses every rule after
 * it, this one included, so the rule alone cannot see one. The companion test
 * therefore also scans the source trees (src, the server packages, scripts,
 * e2e) with `lacksReason` directly, where no directive can suppress the check.
 *
 * Written as a local rule because the community plugin that has it
 * (`eslint-comments/require-description`) is not a dependency, and this is
 * the whole of what it would be used for.
 *
 * @coordinates-with eslint.config.js — registers it as `vmark/require-disable-reason`
 * @coordinates-with scripts/lib/eslintRequireDisableReason.test.mjs — RuleTester cases, config wiring, src scan
 * @module scripts/lib/eslintRequireDisableReason
 */

const DIRECTIVE = /^eslint-disable(?:-line|-next-line)?(?:\s|$)/u;
/** ESLint's description separator, and the description after it. */
const DESCRIPTION = /\s-{2,}\s([\s\S]*)$/u;

/**
 * True when `commentValue` (a comment's text without its delimiters) is a
 * disable directive with no non-blank description.
 *
 * @param {string} commentValue
 * @returns {boolean}
 */
export function lacksReason(commentValue) {
  const text = commentValue.trim();
  if (!DIRECTIVE.test(text)) return false;
  return !DESCRIPTION.exec(text)?.[1]?.trim();
}

/** @type {import("eslint").Rule.RuleModule} */
export const requireDisableReason = {
  meta: {
    type: "suggestion",
    docs: { description: "Require a `-- reason` description on every eslint-disable directive" },
    schema: [],
    messages: {
      missing:
        "Say why this rule does not apply here: add ` -- <reason>` after the rule list of this eslint-disable directive.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (lacksReason(comment.value)) context.report({ loc: comment.loc, messageId: "missing" });
        }
      },
    };
  },
};
