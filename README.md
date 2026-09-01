# agent-team-runner

`agent-team-runner` is a local daemon that executes a versioned
`ExecutionContract`. It does not create product specifications or task plans.
An outer controller owns those decisions and submits an explicit contract.

## Control Plane

Start the local daemon and connect the MCP bridge:

```sh
agent-team start
agent-team mcp
```

The daemon stores projects, policy revisions, runs, interactions, controller
ownership, and events below `$AGENT_TEAM_HOME` (or the platform default).

## Daemon Bootstrap Configuration

Starting the daemon creates `$AGENT_TEAM_HOME/config.yml` if it does not already
exist. It is strict YAML: unknown fields and incorrect value types prevent the
daemon from starting. The configuration is read at daemon startup, so restart
the daemon after changing it.

```yaml
version: 1
concurrency:
  maxActiveRuns: 3
logs:
  retentionDays: 30
tui:
  color: auto
```

`concurrency.maxActiveRuns` limits active execution runs for this daemon across
all projects. Queued eligible runs are started when an active run releases a
slot. `tui.color` controls ANSI styling in `agent-team attach` (`auto`,
`always`, or `never`). `logs.retentionDays` is currently a persisted preference
only; this version does not automatically delete run logs or artifacts.

The IPC endpoint remains fixed to `$AGENT_TEAM_HOME/daemon.sock` on Unix-like
platforms and `\\.\pipe\agent-team` on Windows. Socket path configuration is
not supported.

## Legacy Migration

Move terminal state from an older project-local `.agent-team` directory into
the current global home:

```sh
agent-team migrate                       # source repository is the current directory
agent-team migrate /path/to/repository --dry-run
agent-team migrate --repo /path/to/repository --home /path/to/global-home
```

`migrate` first verifies the source SQLite database with `quick_check`, rejects
non-terminal runs, and checks every destination run name before writing. It
creates a SQLite backup rather than copying a live WAL file. Migration is only
available when `$AGENT_TEAM_HOME/state.sqlite` does not exist: SQLite databases
are not merged, and neither an existing state database nor an existing run
directory is ever overwritten. `--dry-run` performs all checks without writing.

The safe migration scope is terminal state and `.agent-team/runs` artifacts.
Git worktrees, including any `.agent-team/worktrees` directory, are deliberately
left in place and reported. Moving a registered Git worktree requires updating
its repository metadata and cannot be made safe by copying files. Complete or
clean up active legacy runs before migrating; the old source directory is kept
as an untouched backup after a successful migration.

MCP exposes only fixed control-plane tools. A controller can:

1. Register a Git repository with its execution policy.
2. Submit an `ExecutionContract` for that registered project.
3. Attach to the run, read status and durable events, and answer interactions.
4. Validate or revise a blocked run's contract, then start or cancel an eligible run.
5. Retrieve the durable handoff after an execution completes.

`execution.submit` creates a planned run and schedules it in the daemon. The
daemon recreates its runtime configuration from the project's pinned policy
revision, so a restart does not depend on the MCP client's process.

## Attach

Use a terminal client to select and monitor a run, or provide its ID directly:

```sh
agent-team attach [run-id] [--home PATH]
```

Attach obtains the run controller lease, renders durable agent events and
execution state, and handles approvals, agent questions, and contract blocks.
It requeues claimed interactions and releases the controller when it exits.

Without a run ID, a TTY shows registered projects and their runs; use Up/Down
and Enter to attach, or `q`/Ctrl-C to leave. In an attached dashboard, Up/Down
select an agent, `a` answers the next Inbox interaction, and `l` reads and renders
a bounded tail of the selected agent's daemon-recorded log. If that log is
unavailable, the dashboard shows that agent's durable event history instead. The
attach UI is keyboard-only and does
not provide mouse support or complete MCP elicitation handling. Without a TTY,
omitting the ID prints the available project/run list and does not attach.

Events are replayed from a durable cursor. The client acknowledges an event
cursor only after it has rendered the prior batch, so an interrupted attach
session can safely replay events.

The daemon exposes `execution.agent_log` for controlled log fallback. It accepts
only `runId`, `agentId`, optional `maxLines` (1-200), and optional `maxBytes`
(1-65536); it resolves the log path from `StateDatabase`, requires it to remain
inside the managed run directory after symlink resolution, and never accepts a
caller-supplied filesystem path. The MCP bridge exposes the same operation as
`agent_team_read_agent_log`.

## Contract Blocks

Workers must not expand scope themselves. When a task requires a changed scope,
acceptance criterion, dependency, access grant, or other contract change, they
return `blocked_on_contract` with a structured reason. The daemon then:

- ends that worker attempt without verification, review, or retry;
- marks the task `blocked_on_contract` and the run `needs_attention`;
- persists a `WORKER_BLOCKED_ON_CONTRACT` event; and
- queues a durable `contract_block` interaction for the controller.

Answering that interaction records acknowledgement only. The outer controller
must use `agent_team_update_task_contract` with a full revised contract. The
daemon stores an immutable revision, rejects changes to approved tasks, and
resets only the blocked task plus its unfinished downstream tasks. Completed
runs produce `handoff.json` and `handoff.md` beneath the global run directory;
controllers read the structured form through `agent_team_get_handoff`.

## Roles And Skills

The supported execution roles are `worker`, `reviewer`, and `integrator`.
Projects may declare local implementation skills; required skills are resolved,
snapshotted with a SHA-256 digest, and injected into the Worker prompt.

`agent-team init` and `agent-team skills sync` mirror only these supported role
skills for installed hosts. There is no Lead role and no goal-file planning
command.

## Development

```sh
npm run build
npm test
npm run test:coverage
```

The coverage command requires 100% branch and function coverage.
