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

MCP exposes only fixed control-plane tools. A controller can:

1. Register a Git repository with its execution policy.
2. Submit an `ExecutionContract` for that registered project.
3. Attach to the run, read status and durable events, and answer interactions.
4. Start, resume, or cancel an eligible run.

`execution.submit` creates a planned run and schedules it in the daemon. The
daemon recreates its runtime configuration from the project's pinned policy
revision, so a restart does not depend on the MCP client's process.

## Attach

Use a terminal client to monitor one run and handle its interactions:

```sh
agent-team attach <run-id> [--home PATH]
```

Attach obtains the run controller lease, renders durable agent events and
execution state, and handles approvals, agent questions, and contract blocks.
It requeues claimed interactions and releases the controller when it exits.

Events are replayed from a durable cursor. The client acknowledges an event
cursor only after it has rendered the prior batch, so an interrupted attach
session can safely replay events.

## Contract Blocks

Workers must not expand scope themselves. When a task requires a changed scope,
acceptance criterion, dependency, access grant, or other contract change, they
return `blocked_on_contract` with a structured reason. The daemon then:

- ends that worker attempt without verification, review, or retry;
- marks the task `blocked_on_contract` and the run `needs_attention`;
- persists a `WORKER_BLOCKED_ON_CONTRACT` event; and
- queues a durable `contract_block` interaction for the controller.

Answering that interaction records acknowledgement only. The outer controller
must submit a revised execution contract rather than silently mutate a pinned
run.

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
