#!/usr/bin/env bash
# PostToolUse(Edit|Write): format/lint the changed file. Never fails the edit.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/_lib.sh"
payload="$(cat)"
f="$(json_get .tool_input.file_path "$payload")"
root="${CLAUDE_PROJECT_DIR:-$(cd "$here/../.." && pwd)}"
[ -n "$f" ] && [ -f "$f" ] || exit 0
case "$f" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.md|*.css|*.yml|*.yaml)
    bin="$root/node_modules/.bin"
    [ -x "$bin/prettier" ] && "$bin/prettier" --write "$f" >/dev/null 2>&1
    case "$f" in
      *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
        [ -x "$bin/eslint" ] && (cd "$root" && "$bin/eslint" --fix "$f" >/dev/null 2>&1) ;;
    esac ;;
esac
exit 0
