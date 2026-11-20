#!/usr/bin/env bash
# Mini-tools factory (mini-tools.yml), build job: deterministic checks of one tool before anything is published.
#   IDENTITY_PATTERN=<secret regex> bash minitools/verify.sh <slug>        (run in the directory that holds work/)
# Checks: both repos exist with commits and a clean tree; every commit authored AND committed by
# "EpiFive <newsletter@epifive.com>"; no forbidden strings in files or commit messages; licences/README present;
# HANDOFF.md has a "Name check" section; FREE builds a static export (out/index.html).
# THIS REPO IS PUBLIC: prints check names and file names only, never the matched text or the pattern.
set -uo pipefail
s=$1
free="work/$s"; pro="work/$s-pro"
fail=0
bad() { echo "FAIL: $*"; fail=1; }
forbidden="envato|codecanyon|E:\\\\|C:\\\\Users|/home/runner|workers\\.dev"
[ -n "${IDENTITY_PATTERN:-}" ] && forbidden="$forbidden|$IDENTITY_PATTERN"

for r in "$free" "$pro"; do
  if ! git -C "$r" rev-parse HEAD >/dev/null 2>&1; then bad "$r is not a git repo with commits"; continue; fi
  [ -z "$(git -C "$r" status --porcelain)" ] || bad "$r has uncommitted changes"
  others=$(git -C "$r" log --format='%an <%ae>|%cn <%ce>' | tr '|' '\n' | sort -u | grep -vx 'EpiFive <newsletter@epifive.com>' || true)
  [ -z "$others" ] || bad "$r has commits not authored/committed by EpiFive <newsletter@epifive.com>"
  files=$(git -C "$r" grep -I -l -i -E "$forbidden" HEAD -- . 2>/dev/null | sed 's/^HEAD://' || true)
  [ -z "$files" ] || bad "$r: forbidden string in: $(echo $files | tr '\n' ' ')"
  git -C "$r" log --format=%B | grep -q -i -E "$forbidden" && bad "$r: forbidden string in a commit message"
  [ -f "$r/README.md" ] || bad "$r: README.md missing"
done
grep -q -i 'MIT License' "$free/LICENSE" 2>/dev/null || bad "$free: LICENSE is not MIT"
[ -f "$pro/LICENSE-PRO.md" ] || bad "$pro: LICENSE-PRO.md missing"
grep -q -i '^#\+ *Name check' "$free/HANDOFF.md" 2>/dev/null || bad "$free: HANDOFF.md without a 'Name check' section"
grep -q -i -E "$forbidden" "$free/HANDOFF.md" 2>/dev/null && bad "$free: forbidden string in HANDOFF.md"

if [ -n "${VERIFY_SKIP_BUILD:-}" ]; then
  echo "(build skipped: VERIFY_SKIP_BUILD)"
elif [ -f "$free/package.json" ]; then
  ( cd "$free" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ) || bad "$free: npm ci / npm run build failed"
  if grep -q '"test"' "$free/package.json"; then ( cd "$free" && npm test >/dev/null 2>&1 ) || bad "$free: npm test failed"; fi
  [ -f "$free/out/index.html" ] || bad "$free: no static export (out/index.html)"
else
  bad "$free: no package.json"
fi
if [ -z "${VERIFY_SKIP_BUILD:-}" ] && [ -f "$pro/package.json" ]; then
  ( cd "$pro" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ) || bad "$pro: npm ci / npm run build failed"
fi
[ $fail -eq 0 ] && echo "verify $s: all checks passed"
exit $fail
