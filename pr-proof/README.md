# pr-proof

Shows what an agent verified on a PR, under the reply that names it. When Claude writes "shop-web#541 is ready for review", pr-proof adds **▸ Reveal proof**. Press it to see:

- each change on screen as a before and after picture, outlined in red where it changed;
- every check with where it ran and whether it passed, failed or was skipped;
- what was not checked;
- buttons to open a picture, reveal it in Explorer (WSL, Windows) or Finder (macOS), or open the PR.

Pictures are sharp in kitty and Ghostty and drawn as colored blocks in other terminals (and inside tmux, Zellij or Herdr). Both need ImageMagick; without it, the buttons still open and reveal the files.

## Records

pr-proof reads `<root>/<repo>/<pr>/proof.json` and the files beside it, `<root>` being the `root` setting (`~/pr-proof` by default). It names that folder in the system prompt, so Claude writes records where the mod reads them. A reply finds a record by `repo#541`, `owner/repo#541`, an alias the record lists, the PR's GitHub URL, or a bare `#541` (when one record has that number, or inside that repo).

The plugin ships the `record-proof` skill, which tells Claude how to write the record and outline its screenshots while it verifies. The record's shape is in [`skills/record-proof/SKILL.md`](./skills/record-proof/SKILL.md).

`/proof` lists the records; `/proof repo#541` reveals one's folder.

## Settings

- `root`: where records live (default `~/pr-proof`). Set it in `/config`, or in settings as `pluginConfigs.pr-proof.root`.
- `preview`: `auto`, `image` or `blocks`.
