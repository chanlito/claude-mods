# AGENTS.md

Claude Code mods (plugins of function hooks), one folder per mod. The repo is
also a plugin marketplace: `.claude-plugin/marketplace.json` lists every mod.

- A new mod gets its folder, an entry in `.claude-plugin/marketplace.json` and a
  row in the README table, in the same commit.
- `.githooks/pre-commit` validates and tests every mod a commit touches. A
  fresh clone turns it on once: `git config core.hooksPath .githooks`.
- Commits follow [docs/commits.md](./docs/commits.md):
  `<emoji> <type>(<mod>): <subject>`, e.g.
  `🐛 fix(image-peek): force image decoders`.
