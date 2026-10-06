# claude-mods

Claude Code mods (plugins of function hooks), one folder per mod. The repo is
also a plugin marketplace: `.claude-plugin/marketplace.json` lists every mod.

| Mod | What it does |
| --- | --- |
| [image-peek](./image-peek) | Previews pasted images and images Claude sends, with Open and Reveal (Explorer on WSL/Windows, Finder on macOS) buttons and `/reveal-image`, `/open-image` |
| [pr-proof](./pr-proof) | Adds Reveal proof under a reply that names a PR: outlined before/after screenshots, the checks and what was not checked, from `~/pr-proof/<repo>/<pr>/proof.json`; ships the `record-proof` skill that writes it |

## Install

```
/plugin install <mod> --marketplace chanlito/claude-mods
```

## Develop

Run a mod from its folder: `claude --plugin-dir ~/code/claude-mods/<mod>`.
Check it with `claude plugin validate <mod>` and `claude plugin test <mod>`.

A new mod is a folder with `.claude-plugin/plugin.json`, `hooks/hooks.json`
and its hooks module, plus an entry in `.claude-plugin/marketplace.json`.
