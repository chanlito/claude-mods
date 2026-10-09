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
`~/.cache/dev-up/<stack>/`. The pid file also records which boot of the machine
wrote it, so after a reboot a server reads as down rather than crashed, and
`stop` never signals a pid that now belongs to some other process. They outlive the turn, the Claude session and a
reload of the mod, and every session in the stack's folder sees the same ones.
The stack's state shows at the end of the hint line under the prompt, after
`dev`, one colored dot per service: green up, yellow starting, red broken, dim down. A
task whose output exists shows a green ✓. The dots refresh every 30 seconds.

## Installation

```
/plugin install dev-up --marketplace chanlito/claude-mods
```

Answer `y` to add the marketplace, then choose a scope (user is the usual one).
The mod is active right away. It does nothing until a stack file covers the
folder you're in, so the next step is writing one (see Config).

To run it from a clone while developing, without installing:

```
claude --plugin-dir ~/code/claude-mods/dev-up
```

or list the folder in `CLAUDE_CODE_PLUGIN_DIRS` under `env` in
`~/.claude/settings.json`. Don't do both: an installed copy and a folder copy
would load the mod twice.

It needs `sh`, plus `docker` for compose services and `curl` for `report:`.
It finds ports with `ss` (Linux, WSL), or with `lsof` where `ss` is missing
(macOS).

## Config

### The stacks folder

Stack files are read from `~/.claude/dev-stacks/` by default. To use another
folder, change the mod's `stacks` option in `/config`, or set it in
`~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "dev-up@claude-mods": { "options": { "stacks": "~/dotfiles/dev-stacks" } }
  }
}
```

The key is `dev-up` for a copy loaded with `--plugin-dir`.

### A stack file

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
    probe: test -f .seeded # optional: a read-only command, exit 0 = up
    after: [web]

report:                    # probed after every pass
  web: http://localhost:3000/health
```

Each service has exactly one of `compose`, `run`, `task` or `check`.

- **compose**: `docker compose up -d` in that folder. It is up when every
  container in `ready.healthy` reports healthy and every one in `ready.up` is
  running. When Docker Desktop on WSL restarts, a container with a bind mount
  (or a compose `configs:` file) can be left `Exited (127)`, unable to start
  because the mount is gone. The pass sees that in `docker inspect` and
  recreates that container alone. Any other `Exited (127)` gets a WARN.
- **run**: a server. It is up when `port` listens, or while its process lives
  if it has no port. A folder with `package.json` gets a WARN and is not started
  when it has no `node_modules`, or when its `package-lock.json` is newer than
  the last `npm install` (a pull added a package).
- **task**: a one-off command that is done once `creates` exists.
- **check**: an executable for anything a stack file can't say. It runs with
  the root as its working folder, `DEV_UP_STACK` and `DEV_UP_ROOT` set, and
  `--dry-run` on a dry run. It prints lines starting `UP`, `STARTED`, `SKIP`,
  `WARN` or `ACTION`, which `/dev-up` relays; any other line is shown as is.
  The worst prefix it printed sets the service's state. The script runs on
  every pass once what it waits for is up, since it is its own health check.
  Its last result is saved in `~/.cache/dev-up/<stack>/<service>.check`, so a
  reload and every other session see it, until the machine restarts. Between passes the refresh never runs
  the script, because it may act. If you give it a `probe:`, a read-only
  command whose exit 0 means up, the refresh runs that instead, from the root.

The file is a subset of YAML: maps, lists, `[a, b]`, `{ k: v }`, quotes and `#`
comments.

## Commands

| | |
| --- | --- |
| `/dev-up` | one pass |
| `/dev-up --dry-run` | what a pass would do; check scripts get `--dry-run` |
| `/dev-up status` | each service's state and why |
| `/dev-up panel` | a pane with one cell per service in a grid: its state on the border, the end of its log inside, a restart button; refreshed every 3 seconds while open |
| `/dev-up restart <svc> [args]` | stop and start one service; anything after its name is added to its command this once, so `restart metro -- --clear` runs `npm start -- --clear`. A compose service is recreated |
| `/dev-up stop [<svc>]` | stop one service, or every server and task (containers stay up) |
| `/dev-up logs <svc> [n]` | the last `n` lines of its log (40) |
| `/dev-up use <dir>` | serve the servers and tasks of `<dir>`'s repo from that worktree |
| `/dev-up restore [<svc>]` | serve them from their own folders again |

### Worktrees

`/dev-up use ~/code/shop-wt/feat` finds the servers and tasks whose folders
are in the same git repo as that worktree. It restarts them from the matching
folder in the worktree and keeps serving them from there on every later pass,
until `/dev-up restore`. A server that waits on something not up yet starts on
the next pass instead. Containers and check scripts stay where they are.

There is one port per server, so a move applies to every session, not just
yours. The hint line shows it: `web@feat` means `web` is served from the
`feat` worktree. If the worktree is removed, its services go back to their own
folders on the next pass.

Stopping goes by process group and then by port, so a watcher's child that
outlived its parent and still holds the port is stopped too.

Claude gets the same commands as the `dev_up` tool. Its description tells
Claude to use the tool rather than starting servers from Bash, where they
would die with the turn.

## FAQ

**Why doesn't `/dev-up` wait until everything is up?**
A pass that waits would hold the turn for minutes while containers turn
healthy and emulators boot. A pass returns right away and says what it skipped.
Run `/dev-up` again when you're ready. Claude does the same with the `dev_up`
tool, calling `status` again after a pause.

**Do the servers stop when I close Claude?**
No. They run in a session of their own and keep going until you run
`/dev-up stop`, or until they exit by themselves. Any Claude session in the
stack's folder sees them, and a pass leaves them alone.

**Where is a server's output?**
In `~/.cache/dev-up/<stack>/<service>.log`. `/dev-up logs <service> 100` shows
the end of it. For a compose service, it shows `docker compose logs`.

**I started a server myself in a terminal. Will `/dev-up` start a second one?**
No. A server counts as up when its port listens, whoever started it. `stop` and
`restart` stop whatever holds that port, though, so they reach your terminal's
server too.

**It says "No stack covers …"**
No stack file's `root:` holds the session's folder. Check the `root:`, and that
the file is in the stacks folder and ends in `.yml` or `.yaml`. A file that
fails to load is named at the end of the message, with what is wrong in it.

**`npm` or another command is "not found" in the log.**
Commands run with the environment Claude Code was started with. A Claude
started from your shell has your PATH; one started some other way may not. Put
what the command needs in `run:` itself, for example
`run: . ~/.nvm/nvm.sh && npm run dev`, or give the full path.

**I already have a `/dev-up` skill or command.**
The mod leaves the name to it and says so once. The `dev_up` tool and the status
line still work. Rename or remove the other one to get the command.

**Why YAML without anchors or multi-line strings?**
A mod runs without npm packages, so it carries its own small parser. It reads
what a stack file needs: maps, lists, `[a, b]`, `{ k: v }`, quotes and comments.
Anything else is an error that names the line.

**Can two sessions each serve their own worktree?**
Not on the same port. `use` moves a server for everyone, so one session's move
replaces another's. Run one branch at a time, or give the second checkout its
own stack file with other ports.

**When do the dots update?**
Every 30 seconds, and after each `/dev-up` or `dev_up` call. Check scripts run
only during a pass, so a check service shows what it said last time.

**Does it run on Windows?**
Under WSL, yes. On native Windows, no: it needs `sh`.

## Develop

`claude plugin validate dev-up`, `claude plugin test dev-up`, and
`dev-up/tests/no-project-names.sh`, which fails if one of your projects' names
reaches the mod. It takes the names from your own stack files (each stack's
name, root folder, and `cwd:` and `compose:` folders), plus
`<stacks>/private-words`, one word per line, for names a stack file doesn't
spell out. So the check names no project itself. Those names belong in the
project's stack file.
