#!/usr/bin/env bash
# Installs the global Claude Code model strategy.
# Usage: bash tooling/install-claude-global.sh [config_dir ...]
# Default config dir: ~/.claude. For separate accounts pass each one, e.g.
#   bash tooling/install-claude-global.sh ~/.claude ~/.claude-darkduck ~/.claude-nada
set -euo pipefail
SRC="$(cd "$(dirname "$0")/claude-global" && pwd)"
START="<!-- outlet-model-strategy:start -->"
END="<!-- outlet-model-strategy:end -->"
DIRS=("$@"); [ ${#DIRS[@]} -eq 0 ] && DIRS=("$HOME/.claude")

for DIR in "${DIRS[@]}"; do
  mkdir -p "$DIR/agents"
  cp "$SRC"/agents/*.md "$DIR/agents/"

  TARGET="$DIR/CLAUDE.md"
  if [ -f "$TARGET" ] && grep -q "$START" "$TARGET"; then
    python3 - "$TARGET" "$SRC/CLAUDE.md" "$START" "$END" <<'PY'
import sys,re
t,s,a,b=sys.argv[1:5]
text=open(t).read(); block=a+"\n"+open(s).read()+"\n"+b
text=re.sub(re.escape(a)+".*?"+re.escape(b),lambda m:block,text,flags=re.S)
open(t,"w").write(text)
PY
  else
    [ -f "$TARGET" ] && cp "$TARGET" "$TARGET.bak"
    { [ -f "$TARGET" ] && cat "$TARGET" && echo; echo "$START"; cat "$SRC/CLAUDE.md"; echo "$END"; } > "$TARGET.new"
    mv "$TARGET.new" "$TARGET"
  fi

  if [ -f "$DIR/settings.json" ]; then
    echo "[$DIR] settings.json exists, not touched. Add: \"model\": \"opusplan\""
  else
    cp "$SRC/settings.json" "$DIR/settings.json"
  fi
  echo "[$DIR] installed"
done
