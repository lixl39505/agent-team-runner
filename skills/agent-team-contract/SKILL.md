---
name: agent-team-contract
description: ATeam 外层协议——把 ExecutionContract 提交给 Herdr-native 交付控制平面并解读交付结论。当用户要求"蜂群执行一个契约/批量派发编码任务/团队模式跑这批改动"或提及 run、submit、contract 时使用。
---

# ATeam 交付协议（外层规划者视角）

ATeam 把一个版本化的 `ExecutionContract` 交付为可审计的软件变更。你（外层 Agent 或用户）
负责写出正确契约；ATeam Runner 负责任务调度、执行、复核、验证、集成与提交。

## 契约编写规则

1. 每个 task 的 `allowedPaths` 是**独占所有权**：任何两个任务的 allowedPaths 不允许可能
   交叠（glob 语义见 schemas/execution-contract.v1.json）。需要重叠时拆任务或用 dependsOn 串行。
2. `verificationCommands` 会以无 shell 的 argv 执行且必须通过 allowlist（bun/npm/npx/pnpm/
   cargo/go/pytest/make/just 等前缀）。写确定性的、可在 worktree 根目录运行的命令。
3. 影响范围、验收、依赖或路径归属的问题**只能通过契约修订解决**，不要指望 Agent 在 pane 里
   自行扩大范围——Worker 会上报 `blocked_on_contract` 冻结任务。

## CLI

```sh
agent-team submit --contract contract.json        # 只校验并入队（runId 打印到 stdout）
agent-team run --contract contract.json           # 校验 + 本 pane 直接成为 Runner
agent-team runner --run-id <id> --claim           # 在 pane 内认领 queued run 并常驻
agent-team contract validate --contract PATH      # 仅校验
agent-team contract revise --run-id <id> --contract PATH  # 追加不可变修订
agent-team status [<runId>] [--json]              # 交付状态（含 pane id）
agent-team log <runId> [--events] [--task ID]     # 审计事件流
agent-team attach <runId> <taskId>                # 输出 herdr focus 命令以接管 pane
agent-team reconcile [--run-id] [--dry-run]       # 恢复协调
agent-team clean <runId>                          # 终结 run 并回收资源
agent-team doctor --runtime herdr                 # 运行时自检
```

## 退出码

| 码 | 含义 |
|---|---|
| 0 | done：交付完成并持久化 |
| 10 | needs-attention：存在 blocked/耗尽重试的任务，pane 已保留待接管 |
| 11 | contract-blocked：任务因契约问题冻结，需要 revise |
| 1 | failed |
| 130 | interrupted：Runner 被中断，可重连恢复 |

## 恢复语义

- detach 后 Agent 继续运行；Runner 重连复用同一执行，**不会重复发 prompt**。
- Herdr server 重启后运行 `agent-team reconcile`：先订阅再快照，落盘结果会被补做状态转换；
  只有既无可恢复执行又无有效结果的任务才会创建新 attempt。
