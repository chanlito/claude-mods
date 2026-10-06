#!/usr/bin/env bash
# Puts a PR's proof pictures where its description can show them: the repo's
# orphan `pr-proof` branch, one folder per PR, written through the GitHub API
# with no checkout. Prints the Markdown for the PR's Evidence section.
#
#   publish-pictures.sh <owner/repo> <pr> <picture>...
#
# Pictures named <name>-before.<ext> and <name>-after.<ext> pair up into one
# table row; any other picture gets a row of its own. PNGs go up as JPEG
# (quality 88): a phone screenshot drops from ~1 MB to ~80 KB.
#
# Needs `gh` signed in with write to the repo, and ImageMagick (7's `magick`
# or 6's `convert`) for the PNGs.
set -euo pipefail

[[ $# -ge 3 ]] || { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
REPO=$1 PR=$2
shift 2
[[ $PR =~ ^[0-9]+$ ]] || { echo "pr must be a number, got $PR" >&2; exit 2; }

has() { local p; p=$(command -v "$1" 2>/dev/null) && [[ $p != /mnt/* ]]; }
if has magick; then im() { magick "$@"; }
elif has convert; then im() { convert "$@"; }
else im() { echo "ImageMagick is missing, so $1 cannot become a JPEG" >&2; return 1; }
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

entries=()
names=()
for src in "$@"; do
  [[ -f $src ]] || { echo "no such file: $src" >&2; exit 1; }
  base=$(basename "$src")
  case ${base,,} in
    *.png) name=${base%.*}.jpg; im "$src" -quality 88 "$WORK/$name" ;;
    *.jpg | *.jpeg | *.gif | *.webp) name=$base; cp "$src" "$WORK/$name" ;;
    *) echo "not a picture: $src" >&2; exit 1 ;;
  esac
  sha=$(jq -n --rawfile c <(base64 -w0 "$WORK/$name") '{content: $c, encoding: "base64"}' |
    gh api "repos/$REPO/git/blobs" --input - -q .sha)
  entries+=("$(jq -nc --arg p "$PR/$name" --arg s "$sha" '{path: $p, mode: "100644", type: "blob", sha: $s}')")
  names+=("$name")
done
tree_items=$(printf '%s\n' "${entries[@]}" | jq -sc .)

# The branch holds pictures only, so it starts from nothing the first time.
if parent=$(gh api "repos/$REPO/git/ref/heads/pr-proof" -q .object.sha 2>/dev/null); then
  base_tree=$(gh api "repos/$REPO/git/commits/$parent" -q .tree.sha)
  tree=$(jq -nc --arg b "$base_tree" --argjson t "$tree_items" '{base_tree: $b, tree: $t}' |
    gh api "repos/$REPO/git/trees" --input - -q .sha)
  commit=$(gh api "repos/$REPO/git/commits" -f message="proof for #$PR" -f tree="$tree" -f "parents[]=$parent" -q .sha)
  gh api -X PATCH "repos/$REPO/git/refs/heads/pr-proof" -f sha="$commit" >/dev/null
else
  tree=$(jq -nc --argjson t "$tree_items" '{tree: $t}' | gh api "repos/$REPO/git/trees" --input - -q .sha)
  commit=$(jq -nc --arg t "$tree" --arg m "proof for #$PR" '{message: $m, tree: $t, parents: []}' |
    gh api "repos/$REPO/git/commits" --input - -q .sha)
  gh api "repos/$REPO/git/refs" -f ref=refs/heads/pr-proof -f sha="$commit" >/dev/null
fi

URL="https://github.com/$REPO/blob/pr-proof/$PR"
img() { printf '<img src="%s/%s?raw=true" width="460">' "$URL" "$1"; }
pairs=() singles=()
for n in "${names[@]}"; do
  stem=${n%.*}
  case $stem in
    *-before) after=""; for m in "${names[@]}"; do [[ ${m%.*} == "${stem%-before}-after" ]] && after=$m; done
      if [[ -n $after ]]; then pairs+=("| $(img "$n") | $(img "$after") |"); else singles+=("$n"); fi ;;
    *-after) before=""; for m in "${names[@]}"; do [[ ${m%.*} == "${stem%-after}-before" ]] && before=$m; done
      [[ -n $before ]] || singles+=("$n") ;;
    *) singles+=("$n") ;;
  esac
done
if ((${#pairs[@]})); then
  echo "| Before | After |"
  echo "| --- | --- |"
  printf '%s\n' "${pairs[@]}"
  echo
fi
for n in "${singles[@]}"; do img "$n"; echo; done
