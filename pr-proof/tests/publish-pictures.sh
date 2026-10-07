#!/usr/bin/env bash
# publish-pictures.sh against a stub `gh`: every blob it posts must decode back
# to the picture's own bytes, on GNU and macOS base64 alike (chanlito/claude-mods#14).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/posted"
cat >"$work/bin/gh" <<'GH'
#!/usr/bin/env bash
# Records each blob body and answers with a made-up sha; no branch exists yet.
case $2 in
  */git/blobs) n=$(ls "$POSTED" | wc -l | tr -d ' '); cat >"$POSTED/blob-$n.json"; echo "sha$n" ;;
  */git/ref/heads/pr-proof) exit 1 ;;
  *) [[ " $* " == *" --input - "* ]] && cat >/dev/null; echo sha-other ;;
esac
GH
chmod +x "$work/bin/gh"

# Long enough that GNU base64 would wrap it, so a newline left in fails too.
head -c 4096 /dev/urandom >"$work/shot.jpg"

out=$(POSTED="$work/posted" PATH="$work/bin:$PATH" \
  bash "$here/../bin/publish-pictures.sh" acme/shop 7 "$work/shot.jpg")

blob="$work/posted/blob-0.json"
[[ -f $blob ]] || { echo "no blob was posted"; exit 1; }
(($(jq -r .content "$blob" | wc -l) <= 1)) || { echo "blob content is wrapped"; exit 1; }
jq -r .content "$blob" | base64 -d >"$work/decoded" 2>/dev/null ||
  jq -r .content "$blob" | base64 -D >"$work/decoded"
cmp -s "$work/shot.jpg" "$work/decoded" || { echo "blob does not decode to the picture"; exit 1; }
grep -q 'pr-proof/7/shot.jpg' <<<"$out" || { echo "no <img> line for the picture"; exit 1; }
echo "publish-pictures: blob decodes to the picture"
