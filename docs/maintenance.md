# 运行维护指南

本文覆盖 headless CLI 形态(ADR 0002)的日常运维。daemon/IPC/MCP 时代的
操作手册已随该架构删除。

## Run 生命周期

```sh
agent-team run --contract ./contract.json          # 创建并执行
agent-team status                                   # 最近一个 run 的状态
agent-team status <run-id>                          # 指定 run
agent-team log <run-id> <agent-id> --lines 100      # agent 日志尾(符号链接防护)
agent-team run --contract ./contract.json --run-id <run-id> ...   # 重放
agent-team clean <run-id>                           # 删除 worktree/分支,标记 cancelled
```

重放是幂等的:已 approved 的任务跳过;崩溃或被中断的在途任务在重放开始时由
`resetInterrupted` 重置;worker 通过后端 session resume 续上下文,不从头重做。
重放钉住 run 持久化的项目与策略修订:契约声明的 `project.id` 与 run 记录不一致、
run 没有持久化项目、或非 `blocked_on_contract` 的 run 携带不同契约重入,都会被
直接拒绝(不会按新契约静默改配旧 run)。

## 退出码与产物

| exit | 含义 | 关键产物 |
|---|---|---|
| 0 | 全部任务 approved 并完成集成 | `runs/<id>/handoff.json`、`handoff.md` |
| 10 | 存在待外层决定的审批/提问 | `runs/<id>/pending.json` |
| 11 | 存在 `blocked_on_contract` 任务 | `runs/<id>/blockers.json` |
| 1 | 失败(run 或任务终态失败,且无待决项) | 事件与 `status` 输出 |
| 130 | 被信号中断,可重放续作 | 事件 `RUN_INTERRUPTED` |

stdout 最后一行是机器可读 JSON(`runId`/`kind`/`exit`/`pending`/
`contractBlockedTaskIds`),供外层控制器解析。

## 审批与 allowlist 沉淀

- 默认 eager 退出:首个 pending 后经 `--debounce-ms`(默认 10000)防抖即中止,
  携带全部已收集项;`--exit-mode quiescence` 跑到自然停止点再批量上报。
- 恢复:`run --run-id <id> --grant decisions.json`,decisions 为
  `{ "<pendingId>": "approve" | "deny" }`。
- approve 的命令按原样沉淀进项目 allowlist(`project_policy_revisions`
  新增 revision,run 指向新 revision);deny 的任务置 failed。
- pending 频繁出现是契约/授权信号:优先沉淀常用命令或修 DAG,而不是改机制。

## 契约修订

仅存在 `blocked_on_contract` 任务且契约内容有实际变化时,`run --run-id`
携带修订版契约才会生成新 revision。规则:project/baseRef 不可变、approved
任务不可变、仅 blocked 任务及其传递下游可被修改、新任务必须依赖受影响任务。

agent 提问(worker/reviewer/integrator 的 AskUserQuestion 类交互)按契约缺口
处理:问题记入 `pending.json` 并把任务置为 `blocked_on_contract`
(`code: missing_requirement`),run 以 exit 10 上报;`--grant` 不能回答问题,
唯一回答通道是修订契约(如补充 `implementationGuidance`)后重入。

## 跨厂商强制验收

reviewer 的后端必须与 worker 不同(默认强制,创建 run 时即 fail-fast,任务级
`agent` 选择不能绕过)。自动注册的项目默认 worker/integrator 走 claude、
reviewer 走 codex;单后端环境需在项目策略里配置
`agentProfileMapping.roles.reviewer` 指向另一后端的 agent,或显式把
`backendPolicy.crossVendorReview` 置为 `false` 降级。

## 常驻与断线

run 进程即 run 本身。长时间无人值守的 run 应放进常驻终端运行时(如 Herdr 的
受管 pane);进程死亡后,同 runId 重放从盘上状态恢复,worktree 保留复用。

## 清理

`agent-team clean <run-id>` 删除该 run 在项目仓库中的任务 worktree、任务分支
与集成分支,并将 run 标记为 `cancelled`(此后不可重放)。run 的日志与结果
目录保留在 `$AGENT_TEAM_HOME/runs/<id>/`,按需手工归档。

## 故障排查

1. `agent-team status <run-id>` 查看 run/task 终态与 lastError。
2. `agent-team log <run-id> <agent-id>` 看 agent 输出尾(自动校验路径在
   run 目录内并解析符号链接,拒绝越界)。
3. 事件表(`events`)保留完整执行轨迹,`RUN_STARTED`/`WORKER_*`/`TASK_*`/
   `RUN_INTERRUPTED` 等可用于定位阶段。
4. 崩溃后 worktree 有残留属预期:重放会复用;彻底放弃用 `clean`。

## 迁移

旧版项目内 `.agent-team/` 目录在新架构下没有任何运行时含义,可直接归档删除;
其 SQLite/runs 与现行全局 schema 不兼容,不提供自动迁移。
