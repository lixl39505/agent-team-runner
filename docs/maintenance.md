# 运行维护指南

本文面向维护本机 `agent-team-runner` daemon 的操作者。运行状态属于
`$AGENT_TEAM_HOME`，不是目标仓库的 `.agent-team` 目录；目标仓库仅提供 Git
工作区和可选 implementation Skill。

## Daemon 生命周期

使用 `agent-team start` 启动或复用本机 daemon；它会等待固定 IPC endpoint 可用
再进入 Inbox。也可直接运行 `agent-team-daemon [--home PATH]`。Unix-like 平台的
endpoint 是 `$AGENT_TEAM_HOME/daemon.sock`，Windows 是 `\\.\pipe\agent-team`。

- daemon 启动时创建并严格读取 `$AGENT_TEAM_HOME/config.yml`；修改配置后必须重启。
- `daemon.lock` 和 `daemon.json` 记录 PID、启动时间和协议版本。存活 PID 的 lock
  会拒绝第二个 daemon；死 PID 或损坏的 lock 会被替换。
- IPC socket 权限在 Unix-like 平台被限制为 `0600`。不要共享、移动或手工改写 socket。
- `agent-team start`、`agent-team attach` 和 MCP gateway 都只是客户端。离开 Inbox、
  断开 MCP 或关闭终端不会停止 daemon 或取消已提交的 run。
- 通过 `SIGINT` 或 `SIGTERM` 停止 daemon 时，活跃执行收到 abort，持久状态转为
  `recovering`；daemon 会等待执行退出后才关闭 SQLite 和释放 lock。

检查 daemon 是否可达可使用 `agent_team_get_status`，或重新运行 `agent-team start`。
不要用删除 socket 的方式停止 daemon。

## 运行恢复

run 的契约、项目 policy revision、任务、事件、agent execution、交互和 controller
cursor 都持久化在 SQLite；`runs/<run-id>/` 保存契约快照、日志、结果及 handoff。

- daemon 启动时释放过期 execution lease 和 controller lease，并重新调度
  `planned` 或 `running` 且 `desiredState=running` 的外部契约 run。
- 中断时仍处于 worker、verification 或 reviewer 阶段的任务，下次调度会成为
  `changes_requested`/`recovered`；已有 worktree 会重置到其记录的起点，再以新会话
  执行。不要假设中断中的后端会话可继续。
- `paused` run 不会自动恢复。使用 `agent_team_start_run` 或 `agent-team attach`
  对应操作显式恢复；`cancelled` run 也需显式重新启动。
- 重启后 runtime 配置从 run 固定的项目 policy revision 重建，不依赖原 MCP client
  仍在运行。若该 policy 或 run 数据损坏，应停止 daemon、备份 home 后排查，而不是
  直接编辑 SQLite。

`ExecutionContract.target.integrationBranch` 是完成 run 的目标集成分支；未提供时
使用 `agent-team/<run-id>/integration`。handoff 会记录实际 integration branch 和
commit。

## Controller Lease 与重连

controller 对一个 run 具有临时独占 lease。attach 时提供稳定的 `clientId`，可选的
`externalThreadId` 仅作外层 Host 关联记录。

- `agent_team_attach_controller` 返回完整 reconnect context：契约、run、任务、agent
  executions、事件、交互、blocker、handoff 和受控日志尾部。
- `agent_team_read_run_events` 用 `afterEventId` 明确确认已渲染事件。读取本身不推进
  cursor；客户端中断后从持久 cursor 重放。
- 定期调用 `agent_team_heartbeat_controller` 续租。正常断开应调用
  `agent_team_disconnect_controller`，它会释放 lease 并重新排队该 client 已 claim 的
  interaction。
- MCP gateway 关闭时也会执行相同清理，因此 TUI 或另一 MCP client 可以接管。
  若客户端崩溃而未断开，等待 lease 过期后再接管，不要绕过 ownership 直接回答交互。

持久重连不等于 Host thread resume。当前 daemon 保存 `externalThreadId` 并恢复
control-plane context，但不会替任何 Host 自动恢复外部聊天线程；Host thread resume
尚未完成。

## MCP Notification 与 Elicitation

MCP gateway 通过 stdio 连接本机 daemon。它的工具是固定控制面，不暴露 shutdown 或
任意文件路径。

- gateway 从全局 durable event stream 轮询，发送标准 MCP
  `notifications/message` logging notification，logger 为 `agent-team.run`。
- 状态通知的 `data` 是 `{ type: "run.status", runId, status, eventId, eventType,
  createdAt }`。完成通知只发送 `{ type: "run.completed", handoff: { runId,
  available: true } }`，绝不包含 task、contract、handoff 正文或本地路径。
- 通知是尽力而为的连接体验，不替代 `agent_team_read_run_events` 的 durable cursor。
  Host 必须能展示标准 logging notification，或自行轮询事件工具。
- 只有在 client 声明 `capabilities.elicitation.form` 后，已 attach 的 gateway 才会依次
  form elicit 非敏感 approval 和 agent question。它先 claim，只有有效回答才带稳定
  idempotency key 回答。
- `contract_block` 不走 elicitation，必须由 controller 提交完整 revised contract。
  secret、嵌套/数组值不安全的问题、无 capability、取消、失败或断线，都会保持 queued
  或重新入队，供 `agent-team attach` 处理。

Host capability spike 不是已完成的交付项。各 Host 对 notification、elicitation、闲置
会话事件、thread continuation 和断线的实际行为仍需分别验证；不要将本地 fake/protocol
测试视为 Host 兼容性证明。

## Handoff

成功完成的 run 写入 `runs/<run-id>/handoff.json` 与 `handoff.md`，并产生
`RUN_HANDOFF_CREATED` durable event。调用 `agent_team_get_handoff` 获取结构化交接，
其中包含 run 的 policy/contract revision、集成分支/commit、每项任务状态和契约快照。

handoff 不存在通常说明 run 尚未完成、已失败或需要 controller attention。先读取 run、
任务、交互和 durable events；不要根据 MCP 完成通知猜测 handoff 内容。

## 迁移

旧项目级 `.agent-team` 的安全迁移命令为：

```sh
agent-team migrate
agent-team migrate /path/to/repository --dry-run
agent-team migrate --repo /path/to/repository --home /path/to/global-home
```

迁移会执行 SQLite `quick_check`，拒绝非终态 run，检查目标 run 名，并通过 SQLite backup
复制而非复制活动 WAL。目标 `$AGENT_TEAM_HOME/state.sqlite` 必须不存在，迁移不会合并
数据库、覆盖 run 目录或删除源目录。先以 `--dry-run` 验证。

Git worktree 不在迁移范围内。不要复制 `.agent-team/worktrees`；完成或清理旧的活跃 run，
再由 Git 正常管理 worktree 元数据。

## 故障排查

| 症状 | 排查与处理 |
| --- | --- |
| 启动提示 daemon 已运行 | 先用 `agent-team start` 或 health 确认可达；确认对应 PID 已死亡后再重试。不要删除仍存活 daemon 的 lock。 |
| socket 无法连接 | 确认使用同一个 `AGENT_TEAM_HOME`，检查 daemon 日志和 `daemon.json` PID；若无进程，重新执行 `agent-team start`。 |
| run 没有自动继续 | 检查 `status`、`desiredState` 和 project policy revision。`paused`/`cancelled` 必须显式 start；`needs_attention` 要先处理 blocker。 |
| 无法 attach 或 answer interaction | 检查 controller lease owner；由原 client heartbeat、disconnect，或等待 lease 过期后接管。不要用另一个 `clientId` 回答已 claim 的交互。 |
| MCP 没有通知或表单 | 确认 Host 支持 MCP logging；确认 client 声明 form elicitation。无能力时改用 `agent-team attach` 和 durable event 工具。 |
| 获取不到 handoff | 确认 run 已 `done` 且存在 `RUN_HANDOFF_CREATED`；读取 run events 和错误字段定位失败或 integration 问题。 |
| agent log 不可读 | 仅能读取 daemon 记录且位于受管 run 目录内的常规文件。不要传入路径；检查磁盘、权限和日志是否已创建。 |
| 需要恢复后端会话 | 当前恢复策略是 durable run/task 状态加干净会话，不保证原 Host thread 或后端 session continuation。 |

提交前的离线验收可运行 `npm test`。P2 daemon 验收中的三后端路径使用现有
`FakeBackend` seam，不访问 Claude、Codex 或 OpenCode 网络；真实 CLI/协议检查仍按
`npm run test:protocol` 和环境门控的 integration 测试单独执行。
