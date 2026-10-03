# agent-team（ATeam）

**Herdr-native 交付控制平面**：把一个版本化的 `ExecutionContract` 交付为可审计的软件变更。
任务 DAG、路径独占、三角色执行（Worker/Reviewer/Integrator）、机械验证、集成提交与审计
由 ATeam 持久化状态机决策；终端、pane、Agent 会话与 worktree 由 [Herdr](https://herdr.dev)
提供。设计权威见 [docs/adr/0001-herdr-native-delivery-control-plane.md](docs/adr/0001-herdr-native-delivery-control-plane.md)。

## 快速开始

```sh
bun install                 # 仅 devDependencies（typescript/@types/bun）；运行时零依赖
bun run check               # tsc --noEmit + bun test

# 运行时自检（版本 / api schema / 能力矩阵 / 三 agent CLI / git）
bun src/cli.ts doctor --runtime herdr

# 提交契约并入队；Runner pane 认领
bun src/cli.ts submit --contract contract.json
bun src/cli.ts runner --claim

# 或一步到位（本 pane 即 Runner pane）
bun src/cli.ts run --contract contract.json

# 观测与恢复
bun src/cli.ts status [<runId>] [--json]
bun src/cli.ts log <runId> [--task ID]
bun src/cli.ts attach <runId> <taskId>      # 输出 herdr focus 命令
bun src/cli.ts contract revise --run-id <id> --contract v2.json
bun src/cli.ts reconcile [--run-id] [--dry-run]
bun src/cli.ts clean <runId>
```

## 交付不变量

- **完成凭据只有一个**：通过 schema 校验、双读 digest 一致且已持久化的角色结果文件
  （`<home>/runs/<runId>/results/...`，`<final>.partial → rename` 原子写）。终端文本与
  `idle/done/unknown` 状态一律不是凭据。
- **prompt 恰发一次**：`executions.prompt_sent_at` 是唯一守卫；detach 重连与 server 重启
  后的 reconcile 绝不重发。
- **pane 关闭纪律**：仅当结果、复核、验证与状态转换全部持久化后关闭成功 pane；
  `blocked`/失败/未持久化的 pane 保留可 attach。
- **blocked 不新建 attempt**：原生审批 UI（Herdr `blocked`）或结果状态 `blocked` 只冻结
  等待；`blocked_on_contract` 通过 `contract revise` 解除。
- **回收顺序固定**：close pane → worktree.remove → 确认无 worktree 占用 → 删 branch →
  审计落库；每步可重试，仅作用于 ATeam provenance 资源。
- **退出码**：0=done、10=needs-attention、11=contract-blocked、1=failed、130=interrupted。

## 代码地图

| 目录 | 职责 |
|---|---|
| `src/core/` | contract 校验/DAG/路径所有权、path-policy、git 门禁原语、shell allowlist、错误与退出码 |
| `src/store/` | bun:sqlite STRICT 交付台账（runs/tasks/executions/herdr_resources/verifications/cleanup_audit/events/runner_leases） |
| `src/herdr/` | `HerdrRuntimeClient` 窄接口、CLI 传输、NDJSON socket 传输（subscribe/snapshot）、fake 测试替身、agent-args |
| `src/runner/` | 调度引擎、执行生命周期、机械验证、blocked、回收状态机、reconcile |
| `src/results/` | 三角色结果 schema 校验、原子写、prompt/brief 模板 |
| `src/commands/` | run/submit/runner/doctor/status/log/attach/contract/reconcile/clean |
| `schemas/` | contract 与三角色结果的 JSON Schema 文档（权威校验器为手写 TS） |
| `skills/` | 外层协议与三角色 SKILL |
| `plugin/` | Herdr 插件（run/reconcile action + startup hook） |

## 测试

```sh
bun test                    # 全量（约 120 个用例）
bun test test/runner.test.ts  # 交付链路集成测试（fake Herdr + 真实 git worktree）
```

真实 Herdr 的端到端验证见 [docs/e2e.md](docs/e2e.md)（`ATEAM_HERDR_E2E=1` 门控 + 手动清单）。
