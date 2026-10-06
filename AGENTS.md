# AGENTS.md

Claude Code mods (plugins of function hooks), one folder per mod. The repo is
also a plugin marketplace: `.claude-plugin/marketplace.json` lists every mod.

- A new mod gets its folder, an entry in `.claude-plugin/marketplace.json` and a
  row in the README table, in the same commit.
- Before committing a mod: `claude plugin validate .` and
  `claude plugin test <mod>`.
- Commits follow [docs/commits.md](./docs/commits.md):
  `<emoji> <type>(<mod>): <subject>`, e.g.
  `🐛 fix(image-peek): force image decoders`.
