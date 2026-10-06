# dev-up

Brings up a folder's dev stack: Docker containers, dev servers, one-off tasks
and anything else a script can check. You describe the stack once in a YAML
file. `/dev-up` then runs one pass over it and returns at once:

```
UP      db: postgres healthy, mail up
STARTED web: pnpm dev  (log ~/.cache/dev-up/shop/web.log)
SKIP    codegen: waits for web; next run

shop  ● db  ◐ web  ○ codegen
```

Nothing waits. A service started in this pass doesn't count as up for the
services after it, so they are skipped and the next `/dev-up` starts them.
Running it again is both the health check and the way to finish.

Servers start detached (`setsid`), with a log and a pid file under
`~/.cache/dev-up/<stack>/`. They outlive the turn, the Claude session and a
reload of the mod, and every session in the stack's folder sees the same ones.
The stack's state shows in the status line and is refreshed every 30 seconds.

## A stack file

One file per stack in `~/.claude/dev-stacks/<name>.yml`. A session uses the
stack whose `root:` holds its folder (the deepest one wins).

```yaml
name: shop
root: ~/code/shop          # the folder this stack covers
notes: shop/NOTES.md       # shown when a pass ends on a WARN (relative to this file)

services:
  db:
    compose: .             # a folder with docker-compose.yml (relative to root)
    ready: { healthy: [postgres], up: [mail] }

  web:
    cwd: web
    run: pnpm dev          # a server: up when its port listens
    port: 3000
    after: [db]

  codegen:
    cwd: web
    task: pnpm codegen     # a task: done once creates: exists
    creates: src/generated
    after: [web]

  seed:
    check: shop/seed.sh    # a script (relative to this file)
    after: [web]

report:                    # probed after every pass
  web: http://localhost:3000/health
```

Each service has exactly one of `compose`, `run`, `task` or `check`.

- **compose**: `docker compose up -d` in that folder. It is up when every
  container in `ready.healthy` reports healthy and every one in `ready.up` is
  running. A container left `Exited (127)` after Docker Desktop restarts on WSL
  gets a WARN with the `--force-recreate` fix.
- **run**: a server. It is up when `port` listens, or while its process lives
  if it has no port. A folder with `package.json` but no `node_modules` gets a
  WARN and is not started.
- **task**: a one-off command that is done once `creates` exists.
- **check**: an executable for anything a stack file can't say. It runs with
  the root as its working folder, `DEV_UP_STACK` and `DEV_UP_ROOT` set, and
  `--dry-run` on a dry run. It prints lines starting `UP`, `STARTED`, `SKIP`,
  `WARN` or `ACTION`, which `/dev-up` relays; any other line is shown as is.
  The worst prefix it printed sets the service's state.

The file is a subset of YAML: maps, lists, `[a, b]`, `{ k: v }`, quotes and `#`
comments.

## Commands

| | |
| --- | --- |
| `/dev-up` | one pass |
| `/dev-up --dry-run` | what a pass would do; check scripts get `--dry-run` |
| `/dev-up status` | each service's state and why |
| `/dev-up restart <svc>` | stop and start one service; a compose service is recreated |
| `/dev-up stop [<svc>]` | stop one service, or every server and task (containers stay up) |
| `/dev-up logs <svc> [n]` | the last `n` lines of its log (40) |

Stopping goes by process group and then by port, so a watcher's child that
outlived its parent and still holds the port is stopped too.

Claude gets the same commands as the `dev_up` tool. Its description tells
Claude to use the tool rather than starting servers from Bash, where they
would die with the turn.

## Install

```
/plugin install dev-up --marketplace chanlito/claude-mods
```

The stacks folder is the `stacks` option (`~/.claude/dev-stacks` by default).

## Develop

`claude plugin validate dev-up`, `claude plugin test dev-up`, and
`dev-up/tests/no-project-names.sh`, which fails if a real project's names reach
the mod. Those names belong in that project's stack file.
