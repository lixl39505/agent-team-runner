# E2E 验证手册（真实 Herdr）

ADR 0001 §验证标准 的逐条落地清单。自动 e2e 用 `ATEAM_HERDR_E2E=1 bun test test/e2e/`
门控；当前仓库内为手动清单——需要本机安装 Herdr、至少两种 agent CLI（如 claude + codex），
并在一个真实 git 仓库上执行。

## 环境

```sh
herdr --version                 # ≥ 0.7.0
bun src/cli.ts doctor --runtime herdr   # 必须全绿
```

## 用例（对应 ADR 验证标准）

1. **并行 + 跨模型复核**：契约含两个无依赖任务；确认两个 worktree workspace 各自出现
   tab/pane，reviewer 的 agentKind ≠ worker。
2. **原生审批 blocked**：让 worker 触发审批 UI → `herdr agent wait <name> --until blocked`
   命中；`agent-team status` 显示 needs_attention 且 Runner pane 自报 blocked；在原生 UI
   批准后任务继续，**不新建 attempt**（`status` 中 attempts 不变）。
3. **done 无结果**：worker 结束但不写结果文件 → 任务不批准、pane 不关闭
   （`agent-team attach` 可接管）。
4. **Runner 崩溃恢复**：worker 写出结果后 kill Runner 进程 → `agent-team reconcile` →
   不重复 prompt（`log --events` 无第二个 EXECUTION_PROMPTED），只补做验证/集成/清理。
5. **Herdr server 重启**：重启后 `agent-team reconcile` → 先订阅后快照；存活的 worktree
   被 open 复用；丢失的 pane 走新 attempt（分支/worktree 重建有审计事件）。
6. **回收**：run done 后 task branch 与 worktree 全部移除；`cleanup_audit` 五步皆 ok；
   非 ATeam 的 worktree/branch 不受影响。
7. **fail-fast**：停掉 Herdr 或降级版本 → `run`/`submit` 以退出码 1 失败并给出 remediation。
8. **契约修订**：任务 `blocked_on_contract` → `contract revise` → Runner 解除冻结并按新
   spec 重建 attempt（旧执行 abandoned，审计可查）。

## 已知未验证项（待真实 Herdr 环境）

- `herdr worktree create` CLI 参数拼写以 `herdr api schema` 为准（映射集中在
  `src/herdr/runtime-client.ts`，e2e 首跑如有出入只需调整 argv 表）。
- `pane report-agent` 的 CLI 包装名（`pane report-agent`）同理。
- Windows named pipe 的默认路径名（`\\.\pipe\herdr` 为占位，可用 `HERDR_SOCKET_PATH` 覆盖）。
