# Commit & Pull Request Guidelines

The repo uses Conventional Commits. Commit messages must follow:

```
<emoji> <type>(<scope>): <subject>
```

Guidelines:

- Scope is the mod's folder (`image-peek`); leave it out for repo-wide changes.
- Lowercase subject.
- Imperative tone.
- Length ≤ 72 characters.
- Body should explain the _why_ of the changes.

## Commit types & emojis

- ✨ `feat` — a new feature
- 🐛 `fix` — a bug fix
- 📝 `docs` — documentation only changes
- 💄 `style` — changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc.)
- ♻️ `refactor` — a code change that neither fixes a bug nor adds a feature
- ⚡ `perf` — a code change that improves performance
- ✅ `test` — adding missing tests or correcting existing tests
- 📦 `build` — changes that affect the build system or external dependencies
- 👷 `ci` — changes to CI configuration files and scripts
- 🔧 `chore` — other changes that don't modify src or test files
- ⏪ `revert` — reverts a previous commit
