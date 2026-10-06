#!/bin/sh
# Fails when a real project's names leak into the engine. The names come from
# your own stack files, so this file names no project either: each stack's
# name, its root folder's name, and its cwd: and compose: folders, plus any
# words in <stacks>/private-words (one per line) for names a stack file
# doesn't spell out, like a product or a vendor.
#
#   tests/no-project-names.sh [stacks folder]   (~/.claude/dev-stacks)
cd "$(dirname "$0")/.." || exit 2
stacks=${1:-$HOME/.claude/dev-stacks}
words=$(mktemp) || exit 2
trap 'rm -f "$words"' EXIT

for f in "$stacks"/*.yml "$stacks"/*.yaml; do
  [ -e "$f" ] || continue
  sed -e 's/[[:space:]]#.*//' -e 's/^#.*//' "$f" |
    sed -n -E 's/^[[:space:]]*(name|root|cwd|compose):[[:space:]]*["'\'']?([^"'\'']*)["'\'']?[[:space:]]*$/\1 \2/p' |
    while read -r key value; do
      [ "$key" = root ] && value=$(basename "$value")
      case "$value" in "" | . | .. | "~") continue ;; esac
      printf '%s\n' "${value##*/}"
    done
done >> "$words"
[ -f "$stacks/private-words" ] && grep -v '^[[:space:]]*\(#\|$\)' "$stacks/private-words" >> "$words"

if [ ! -s "$words" ]; then
  echo "dev-up: no stack files in $stacks, so no names to look for"
  exit 0
fi
if grep -rniwF -f "$words" .claude-plugin/plugin.json hooks tests README.md; then
  echo "dev-up: the lines above name a project; move them to that project's stack file" >&2
  exit 1
fi
echo "dev-up: none of the $(sort -u "$words" | wc -l | tr -d ' ') names from $stacks appear"
