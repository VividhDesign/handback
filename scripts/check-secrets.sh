#!/usr/bin/env bash
# Fails if any value from ../secrets.env appears in tracked or staged files (or, with --history, in git history).
# Prints only file names and key names, never values.
set -euo pipefail
cd "$(dirname "$0")/.."
SECRETS="../secrets.env"
[ -f "$SECRETS" ] || { echo "check-secrets: no ../secrets.env, nothing to compare"; exit 0; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "check-secrets: not a git repo"; exit 1; }

PATTERNS="$(mktemp)"; KEYS="$(mktemp)"
trap 'rm -f "$PATTERNS" "$KEYS"' EXIT
# Values shorter than 8 chars (sandbox, true, ports) are settings, not secrets.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  [ "${#val}" -ge 8 ] || continue
  printf '%s\n' "$val" >> "$PATTERNS"; printf '%s\n' "$key" >> "$KEYS"
done < "$SECRETS"
[ -s "$PATTERNS" ] || { echo "check-secrets: OK (no secret values set yet)"; exit 0; }

fail=0
hits="$(git ls-files -z --cached | xargs -0 grep -lF -f "$PATTERNS" -- 2>/dev/null || true)"
if [ -n "$hits" ]; then echo "check-secrets: SECRET VALUE FOUND in tracked files:"; echo "$hits"; fail=1; fi
if git diff --cached --quiet 2>/dev/null; then :; else
  if git diff --cached | grep -qF -f "$PATTERNS"; then echo "check-secrets: SECRET VALUE FOUND in staged changes"; fail=1; fi
fi
if [ "${1:-}" = "--history" ] && git rev-parse HEAD >/dev/null 2>&1; then
  if git log -p --all | grep -qF -f "$PATTERNS"; then echo "check-secrets: SECRET VALUE FOUND in git history"; fail=1; fi
fi
[ "$fail" = 0 ] && echo "check-secrets: OK ($(wc -l < "$KEYS" | tr -d ' ') values checked)"
exit "$fail"
