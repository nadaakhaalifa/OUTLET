#!/usr/bin/env bash
# PreToolUse(Bash) guard. Exit 2 + stderr reason blocks the command.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/_lib.sh"
payload="$(cat)"
cmd="$(json_get .tool_input.command "$payload")"
[ -z "$cmd" ] && exit 0
block() { echo "BLOCKED by pre-tool-guard: $1" >&2; exit 2; }
lc="$(printf '%s' "$cmd" | tr '[:upper:]' '[:lower:]')"

# 1. force pushes
if printf '%s' "$lc" | grep -Eq 'git[[:space:]]+(-[^ ]+[[:space:]]+)*push([[:space:]]|$)'; then
  printf '%s' "$lc" | grep -Eq '(^|[[:space:]])(--force([^ ]*)|-[a-z]*f[a-z]*)([[:space:]]|$)' \
    && block "force push is not allowed"
  printf '%s' "$lc" | grep -Eq 'push[[:space:]]+[^ ]+[[:space:]]+\+' && block "force push (+refspec) is not allowed"
fi

# 2. .env reads (allow .env.example/.sample/.template)
stripped="$(printf '%s' "$lc" | sed -E 's/\.env\.(example|sample|template)//g')"
if printf '%s' "$stripped" | grep -Eq '(^|[[:space:]/=<"'"'"'])\.env([^a-z0-9_-]|$)|\.env\.[a-z]'; then
  printf '%s' "$stripped" | grep -Eq '(cat|less|more|head|tail|bat|grep|rg|sed|awk|source|xxd|strings|cp|base64|printenv|env|<)|(^|[;&|[:space:]])\.[[:space:]]' \
    && block "reading .env files is not allowed"
fi

# 3. rm -rf only inside scratchpad / claude temp dirs
if printf '%s' "$lc" | grep -Eq '(^|[;&|[:space:]])rm[[:space:]]+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r[[:space:]]+-f|-f[[:space:]]+-r|--recursive)'; then
  ok=1
  for t in $(printf '%s' "$cmd" | sed -E 's/.*rm[[:space:]]+(-[^ ]+[[:space:]]+)*//'); do
    case "$t" in
      "${CLAUDE_SCRATCHPAD:-/nonexistent}"/*|/private/tmp/claude-*|/tmp/claude-*) ;;
      *) ok=0 ;;
    esac
  done
  [ "$ok" = 1 ] || block "rm -rf is only allowed inside the scratchpad directory"
fi

# 4. database safety: non-local host + psql/pg_*/destructive SQL
destructive=0
printf '%s' "$lc" | grep -Eq 'drop[[:space:]]+(table|database|schema)|truncate' && destructive=1
if printf '%s' "$lc" | grep -Eq 'delete[[:space:]]+from' && ! printf '%s' "$lc" | grep -Eq '[[:space:]]where[[:space:]]'; then destructive=1; fi
dbtool=0
printf '%s' "$lc" | grep -Eq '(^|[;&|[:space:]])(psql|pg_[a-z]+|pgcli)([[:space:]]|$)' && dbtool=1
hosts="$( { printf '%s' "$cmd" | grep -Eo '(-h|--host)[ =]+[^ ]+' | sed -E 's/^(-h|--host)[ =]+//'
            printf '%s' "$cmd" | grep -Eo 'postgres(ql)?://[^ "'"'"']+' | sed -E 's#^[^/]+//([^@/]*@)?##; s#[:/?].*##'
            printf '%s' "$cmd" | grep -Eo 'host=[^ ]+' | sed 's/^host=//'; } )"
nonlocal=0
for h in $hosts; do
  case "$h" in localhost|127.0.0.1|::1|"[::1]") ;; *) nonlocal=1 ;; esac
done
if [ "$nonlocal" = 1 ] && { [ "$dbtool" = 1 ] || [ "$destructive" = 1 ]; }; then
  block "database command targets a non-local host"
fi
if [ "$dbtool" = 1 ] && [ -z "$hosts" ] && printf '%s' "$cmd" | grep -Eq 'PG(HOST|URL)|DATABASE_URL'; then
  block "database command uses an environment-provided host; pass -h localhost explicitly"
fi
exit 0
