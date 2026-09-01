# agent-team-runner

`agent-team-runner` is a local daemon that executes a versioned
`ExecutionContract`. It does not create product specifications or task plans.
An outer controller owns those decisions and submits an explicit contract.

## Control Plane

Start or connect to the local daemon; `start` then opens the Inbox and `mcp` connects the MCP bridge:

```sh
agent-team start
agent-team mcp
```

The daemon stores projects, policy revisions, runs, interactions, controller
ownership, and events below `$AGENT_TEAM_HOME` (or the platform default).
Target repositories are never read for runner configuration or state. A
project-local `.agent-team` directory has no runtime meaning; `migrate` is the
sole, isolated legacy reader for moving terminal state out of that directory.
`start` reuses a reachable daemon or launches `agent-team-daemon` as a detached
child, waits for its IPC endpoint, then opens the same Inbox as `attach`.
Detaching that Inbox never stops the daemon or submitted runs.

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

`migrate` is a read-only legacy source reader before publication: it first verifies
the source SQLite database with `quick_check`, rejects
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

### MCP Notifications And Elicitation

The stdio gateway consumes the daemon's durable event stream and emits standard
MCP `notifications/message` logging notifications with logger
`agent-team.run`. Lifecycle updates use a `data` payload shaped as
`{ type: "run.status", runId, status, eventId, eventType, createdAt }`.
When the durable handoff has been written, it emits only
`{ type: "run.completed", handoff: { runId, available: true } }`; it never
places the handoff body, task data, contract, or local path in that notification.
Use `agent_team_get_handoff` to retrieve the durable handoff.

These notifications are best-effort connection updates, not a replacement for
the durable `agent_team_read_run_events` cursor. The gateway uses only standard
MCP logging notifications rather than a private notification extension, so a
Host must surface MCP logging messages to display them.

### Host Capability Registry

`agent_team_get_host_capabilities` exposes an explicit registry for Claude Code,
Codex, and OpenCode. It records `logging`, `elicitation`, `idleEvent`,
`resumeExternalThread`, and `startReviewTurn` independently. All built-in entries
are intentionally unverified and disabled until a Host-specific integration is
declared. `agent_team_resume_external_thread` and
`agent_team_start_review_turn` require `explicitlyRequested: true`, controller
lease ownership, a declared capability, and an installed Host adapter. Any refusal
or adapter failure returns the durable-context/TUI fallback without changing the
run. Local fake tests and probe skeletons do not prove real third-party Host UI
behavior.

After `agent_team_attach_controller`, the gateway checks the initialized
client's `capabilities.elicitation.form`. A client that declares form support
can receive standard server-initiated `elicitation/create` forms for queued
approvals and non-sensitive agent questions. The gateway claims the interaction
before eliciting and answers it with a stable idempotency key only after a valid
response. It serializes forms one at a time. `contract_block` is deliberately
never elicited: revise it through the normal controller/TUI contract workflow.

MCP form elicitation cannot safely represent secret questions or arbitrary
nested/array values; approval forms deliberately omit tool input and
backend-provided detail. Secret questions, malformed or unsupported questions,
clients without form capability, cancelled/failed elicitation, and client
disconnects remain queued or are requeued for `agent-team attach`. Closing the
MCP connection also stops its single polling timer, requeues interactions it
claimed, and releases its controller leases, so attach can take over immediately.

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
select an agent; Enter or `a` answers the next Inbox interaction; `d` denies the
next queued approval; `l` reads a bounded tail of the selected agent's
daemon-recorded log; and `f` toggles refreshing that tail each poll. If that log is
unavailable, the dashboard shows that agent's durable event history instead. The
attach UI enables SGR terminal mouse clicks for run and agent selection only when
both streams are TTYs and `$TERM` identifies a known VT-compatible terminal. It
does not enable mouse handling for unknown terminals, multiplexers with disabled
mouse forwarding, or terminals that do not support SGR mouse sequences. Keyboard
controls remain available everywhere. Without a TTY, omitting the ID prints the
available project/run list and does not attach; `start` still leaves its daemon
running and safely falls back to that listing.

Events are replayed from a durable cursor. The client acknowledges an event
cursor only after it has rendered the prior batch, so an interrupted attach
session can safely replay events.

`controller.attach` keeps its controller fields and `execution` snapshot, and
now supplies a reconnect context in that snapshot: `contract`, `run`, `tasks`,
`agentExecutions`, replayed `events` and `lastEventId`, all `interactions`,
`blockers` (blocked tasks plus queued or claimed interactions), `handoff` (or
`null`) and `handoffAvailable`, and `agentLogs`. Each `agentLogs` entry is
either `{ agentId, status: "available", tail }` or `{ agentId, status:
"unavailable", reason }`. The tail is read with the same bounded,
daemon-recorded-path checks as `execution.agent_log`; attach accepts no path
parameter.

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
