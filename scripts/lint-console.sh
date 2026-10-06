#!/bin/bash
# Lint for bare console.* calls (every method: log, info, debug, trace, table,
# ...) in production code.
#
# Scans src/ relative to the directory it is run from.
#
# Allowed, each by FILE rather than by anything a line happens to contain:
#   - src/utils/debug.ts and src/utils/debug/**  (they define the loggers)
#   - src/utils/perfLog.ts                       (opt-in dev tool)
#   - src/test/setup.ts                          (test bootstrap)
#   - src/export/pdfHtmlTemplate.ts              (console calls inside a
#                                                 template string that runs in
#                                                 the export page)
#   - *.test.* files and anything under a __tests__/ directory
# plus doc-comment lines (content starting with `*`), which show a call
# without making one.
#
# The exemptions are matched against the PATH field only. They used to be
# `grep -v` filters over the whole `path:line:content` record, so
# `console.log(a * b)` or a message mentioning `utils/debug/` was exempt from
# any file, and `setup\.ts` exempted every file whose name merely ended that
# way.
#
# Fails closed: a missing src/, a tree with no TypeScript file, or a grep
# error is a failure, never "no calls found".
#
# @coordinates-with scripts/lint-console.test.mjs — runs this against fixture trees

set -euo pipefail

if [ ! -d src ]; then
  echo "ERROR: src/ not found in $(pwd) — lint-console has nothing to scan."
  exit 1
fi

SCANNED=$(find src -name node_modules -prune -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print | wc -l | tr -d ' ')
if [ "$SCANNED" -eq 0 ]; then
  echo "ERROR: lint-console scanned 0 files under src/ — refusing to pass vacuously."
  exit 1
fi

# grep exits 1 for "no match" (the good case) and 2+ for a real error.
set +e
HITS=$(grep -rnE '(^|[^A-Za-z0-9_$])console\.[A-Za-z]+' src/ \
  --include='*.ts' --include='*.tsx' --exclude-dir=node_modules)
GREP_STATUS=$?
set -e
if [ "$GREP_STATUS" -gt 1 ]; then
  echo "ERROR: grep failed (exit $GREP_STATUS) — lint-console could not scan src/."
  exit 1
fi

VIOLATIONS=$(printf '%s\n' "$HITS" | awk '
  {
    first = index($0, ":")
    if (first == 0) next
    path = substr($0, 1, first - 1)
    rest = substr($0, first + 1)
    content = substr(rest, index(rest, ":") + 1)

    if (path ~ /\.test\.[A-Za-z]+$/) next
    if (path ~ /\/__tests__\//) next
    if (path == "src/utils/debug.ts") next
    if (index(path, "src/utils/debug/") == 1) next
    if (path == "src/utils/perfLog.ts") next
    if (path == "src/test/setup.ts") next
    if (path == "src/export/pdfHtmlTemplate.ts") next
    if (content ~ /^[ \t]*\*/) next
    print
  }
')

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: Found bare console.* calls in production code."
  echo "Use structured loggers from @/utils/debug instead."
  echo ""
  echo "$VIOLATIONS"
  exit 1
fi

echo "OK: No bare console.* calls found in production code ($SCANNED files scanned)."
