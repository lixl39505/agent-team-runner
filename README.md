# agent-team-runner

`agent-team-runner` is a headless local execution kernel for coding agents. It
takes a versioned `ExecutionContract` from an outer controller (an SDD-style
planning session), fans the work out to Worker/Reviewer/Integrator agents across
Claude Code, Codex, and OpenCode, enforces mechanical verification plus a
physically read-only review, and commits through the Runner — never through the
agents themselves. It does not create product specifications or task plans.

It is one ordinary CLI process per run: no daemon, no IPC server, no MCP layer,
no interactive TUI. A run's lifetime is the process lifetime; durability across
crashes and disconnects comes from on-disk state and replaying the same run.

## Quick start

```sh
agent-team run --contract ./contract.json
echo $?   # 0 done, 10 needs-approval, 11 contract-blocked, 1 failed, 130 interrupted
```

The command creates a run (or replays an existing one), executes the contract's
task DAG, and exits with a machine-readable summary on stdout plus durable
artifacts under `$AGENT_TEAM_HOME/runs/<run-id>/`:

- `pending.json` — approvals/questions that need an outer decision (exit 10)
- `blockers.json` — `blocked_on_contract` tasks with structured reasons (exit 11)
- `handoff.json` / `handoff.md` — the structured handoff (exit 0)

An outer controller reads those files, resolves what it alone can resolve, and
re-enters the run:

```sh
# approve collected approvals: commands sediment into the project allowlist
agent-team run --contract ./contract.json --run-id <id> --grant ./decisions.json

# revise the contract (only blocked_on_contract runs accept revisions)
agent-team run --contract ./contract-v2.json --run-id <id>
```

Replays never rerun approved tasks, never re-ask approved questions, and resume
interrupted workers through backend session resume.

Because a run is one foreground process, long or unattended runs pair naturally
with a terminal runtime (for example [Herdr](https://herdr.dev/)): put the
`agent-team run` process in a managed pane so it survives disconnects. There is
no API coupling — agent-team neither detects nor drives the terminal runtime.

## Interaction model: structured exit

There is exactly one interaction primitive: the structured exit. Workers never
ask questions interactively. A permission request outside the project allowlist
is denied with guidance ("prefer a mechanically equivalent alternative; list
every required operation before ending blocked"), recorded in `pending.json`,
and — in the default `eager` exit mode — aborts the run after a short debounce
window (10s by default, `--debounce-ms`) so the outer controller can decide
early. `--exit-mode quiescence` runs to a natural stopping point and batches
everything collected.

Approved commands are sedimented into the project's persisted allowlist, so
friction decreases run over run. Approved non-command permissions (network,
external directories, tools) are recorded per run in `grants.json` and
auto-approved when the same request re-occurs on replay. Frequent approvals are
a contract smell: widen the project allowlist or fix the DAG, not the mechanism.

## Commands

| Command | Purpose |
|---|---|
| `run --contract PATH [options]` | Create or replay a run. Options: `--run-id`, `--grant PATH`, `--debounce-ms N`, `--max-parallel N`, `--exit-mode eager\|quiescence`, `--home PATH` |
| `status [RUN_ID]` | Render run and task status (latest run by default) |
| `log RUN_ID AGENT_ID [--lines N]` | Bounded tail of a recorded agent log (symlink-safe) |
| `clean RUN_ID` | Remove the run's worktrees and branches; marks it cancelled |
| `init [repo]` / `skills sync [--repo PATH]` | Mirror role skills into the repository for installed hosts |
| `auth set\|status\|logout\|login` | Keychain credentials for backend profiles |

## Contract blocks

Workers must not expand scope themselves. When a task requires a changed scope,
acceptance criterion, dependency, or access grant, the worker returns
`blocked_on_contract` with a structured reason; the run exits `11` with
`blockers.json`. The outer controller revises the contract and re-enters the
run. Revisions are immutable: the project and base ref cannot change, approved
tasks cannot change, and only blocked tasks plus their transitive downstream
are reset. New tasks must depend on an affected task.

## Storage

Everything lives under `$AGENT_TEAM_HOME` (default `~/.agent-team`):

```
~/.agent-team/
  state.sqlite                 # runs, tasks, events, agent executions, contract
                               # revisions, registered projects and policy revisions
  runs/<run-id>/               # contract.json, tasks/, results/, reviews/, logs/,
                               # pending.json, grants.json, blockers.json, handoff.json+md
  worktrees/<repo>/<run-id>/   # task and integration worktrees
```

Target repositories receive only Git branches and worktree metadata (inherent to
Git) plus the role skills copied by `init`/`skills sync`. There is no
project-local `.agent-team` directory and no project-local configuration.

## Roles and skills

The supported execution roles are `worker`, `reviewer`, and `integrator`.
Projects may declare local implementation skills under `<repoRoot>/.agents/skills`;
required skills are resolved, snapshotted with a SHA-256 digest, and injected
into the matching Worker, Reviewer, or Integrator prompt. There is no Lead role
and no goal-file planning command.

## Development

```sh
npm run build
npm test
npm run test:coverage   # requires 100% branch and function coverage
```
