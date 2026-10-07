---
name: record-proof
description: Write the proof record for a PR as you verify it, with before/after screenshots outlined in red, so the person can reveal the proof under your "ready for review" reply. Use when you verify a change by running it (a device, a browser, a CLI) before reporting a PR ready.
---

Every check you run lands in one record, `<records>/<repo>/<pr>/proof.json`, beside the files that show it. `<records>` is the folder the system prompt names for PR proof records (pr-proof's `root` setting, `~/pr-proof` unless changed). `<repo>` is the repository's name (`shop-web`), `<pr>` the PR's number. The person's pr-proof mod reads it and draws it under this session's replies that name the PR (`shop-web#541`, an alias, the PR's URL, or `#541` inside the repo); another session's record shows only once the person names the PR.

## Steps

1. **Make the folder** once you know the PR number: `mkdir -p <records>/<repo>/<pr>`. Save every screenshot, recording and pulled file there, never in a temp folder: the record outlives the session.
2. **Shoot each visible change twice**: the same screen, size, language and data on the base branch (before) and on the PR's branch (after). No before shot means the change gets an after alone, and the record says so by leaving `before` out.
3. **Outline what changed** on each after shot (and on the before when it helps), with the box around the element that changed:

   ```sh
   # ImageMagick 7 is `magick`, 6 is `convert`. Args: in out x0 y0 x1 y1 "label".
   im() { if command -v magick >/dev/null; then magick "$@"; else convert "$@"; fi; }
   outline() {
     im "$1" -fill none -stroke '#dc2626' -strokewidth 6 \
       -draw "roundrectangle $3,$4 $5,$6 12,12" \
       -stroke none -fill white -undercolor '#dc2626' -pointsize 30 -gravity NorthWest \
       -annotate +"$3"+"$(( $4 > 50 ? $4 - 44 : $6 + 8 ))" " $7 " "$2"
   }
   outline after-raw.png warning-after.png 184 82 982 148 "Added: warning"
   ```

   Take the box from the element's real bounds (the UI tree, the DOM, `getBoundingClientRect`) rather than guessing from the picture, and keep the label big: the PR shows the picture at about half its width. Write the label in English: ImageMagick draws Khmer, Thai and other shaped scripts as blanks.
4. **Write `proof.json`** as checks happen, not from memory at the end (shape below). A check you planned and did not run is `"result": "skip"`; something you never tried goes in `notChecked`.
5. **Show the pictures in the PR's description**: `bin/publish-pictures.sh <owner/repo> <pr> <picture>...`, two folders up from this skill's own, uploads them to the repo's `pr-proof` branch and prints the before/after table for the Evidence section.
6. **Name the PR in your reply** (`shop-web#541 is ready for review`). The mod finds the record from that.

Done when every claim in your report has a check in the record, every check on a screen has its file, and everything you did not check is listed.

## proof.json

```json
{
  "repo": "acme/shop-web",
  "pr": 541,
  "session": "<the id the system prompt gives>",
  "title": "Encrypt the local database",
  "url": "https://github.com/acme/shop-web/pull/541",
  "aliases": ["web"],
  "changes": [
    { "title": "Warning on Home", "before": "warning-before.png", "after": "warning-after.png" },
    { "title": "Settings line", "after": "settings-after.png" }
  ],
  "checks": [
    { "claim": "Offline upgrade keeps every row", "where": "Tablet, landscape, English", "result": "pass", "evidence": ["offline.png", "counts.json"] },
    { "claim": "Every crash state", "where": "Unit tests", "result": "pass" }
  ],
  "notChecked": ["The signed release build"]
}
```

- File names are relative to the record's folder; a name with `..` or a leading `/` is ignored.
- `result` is `pass`, `fail` or `skip`. A failed check stays in the record after the fix, followed by the check that passed.
- `aliases` are other names the PR goes by in chat, such as `web` for `web#541`.
- `session` is the id the system prompt gives beside the records folder. It marks the record as this session's, so another session that mentions the PR in passing does not draw it.
- Pictures are PNG, JPEG, GIF, WebP or BMP. In kitty and Ghostty they show sharp; elsewhere as colored blocks.
