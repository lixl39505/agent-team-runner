# ADR 0001：以 Herdr 为运行时的交付控制平面

**状态：** 已接受  
**日期：** 2026-09-30

## 背景

ATeam 用于把一个版本化的 `ExecutionContract` 交付为可审计的软件变更。其核心职责是把
任务拆分后的依赖、路径归属、执行尝试、复核、验证、集成和提交组织成可靠的交付状态机。

Agent 的终端、原生会话、人工交互、远程连接和 Git worktree 则由 Herdr 提供。将这些能力
直接建立在 Herdr 的 workspace、pane、Agent 和 worktree 对象上，能让每个执行单元都保持
可见、可接管、可恢复，同时使 ATeam 专注于交付不变量。

## 决策

ATeam 是 **Herdr-native 交付控制平面**：Herdr 是蜂群执行模式的必需运行时，ATeam 通过
Herdr CLI 和 socket API 创建、定位并协调全部 Agent 执行资源。

ATeam 以 Herdr 插件和命令行入口两种形式提供。插件承担发现、启动、恢复协调和交互入口；
命令行入口可由 Herdr pane 内的用户或上层 Agent 调用。无论入口为何，交付状态机、契约和
审计记录均由 ATeam 持久化管理，不能依赖 Herdr 的 UI 布局状态。

### 职责边界

| 能力 | 归属 | 说明 |
|---|---|---|
| `ExecutionContract` 校验、任务 DAG | ATeam | 固化外层规划者提交的契约，并维护版本与修订。 |
| 依赖调度、路径归属、尝试与跨模型复核 | ATeam | ATeam 是任务状态和交付结论的唯一决策者。 |
| Worker、Reviewer、Integrator 的终端、进程、原生 Agent 会话和 attach | Herdr | 每次 Agent 执行在 Herdr 管理的 pane 中运行。 |
| Agent 原生审批、提问和人工接管 | Herdr | 用户在对应 pane 内完成运行时交互。 |
| Agent 会话持久化、detach、远程连接和原生会话恢复 | Herdr | ATeam 保存资源关联信息并负责恢复交付协调。 |
| Git task worktree 生命周期 | Herdr 优先 | 通过 `worktree.create/open/remove` 管理关联 workspace；ATeam 决定清理资格并记录审计信息。 |
| 结构化结果接收与 schema 校验 | ATeam | Agent 状态不是交付完成凭据。 |
| 机械验证、只读复核、统一 commit/cherry-pick | ATeam | 交付门禁在 ATeam 状态机内执行。 |
| 交付审计、任务状态和恢复协调 | ATeam | 保存契约、结果、复核、验证、提交与 Herdr 资源映射。 |

### 蜂群运行模型

当用户或 Herdr pane 中的上层 Agent 明确请求团队蜂群模式时，ATeam 接收 contract 并创建一个
run。每个 run 都有唯一的 Runner 控制进程，只有 Runner 可以调度任务或写入交付结论。

```text
Herdr workspace: 主仓库 / run <run-id>
└─ Runner pane: ATeam 状态机与交付汇总
   ├─ task-a · worker · attempt-1
   ├─ task-b · worker · attempt-1
   ├─ task-a · reviewer · cycle-1
   ├─ task-b · reviewer · cycle-1
   └─ integrator · task-a
```

pane 的标识粒度固定为 `runId + taskId + phase + attempt/cycle`。同一角色可并发处理多个
任务；Worker 可因复核反馈重试，Integrator 可在集成冲突时创建新的尝试。

隔离任务默认使用一个 task worktree 对应一个 Herdr workspace、tab 和 root pane。Runner
可跨 workspace 协调任务，且必须将保存的 worktree 映射作为工作目录的权威来源，不能依据
pane 的可视位置推断任务目录。

### HerdrRuntimeClient

ATeam 提供窄接口 `HerdrRuntimeClient`，封装 Herdr CLI/socket 调用、版本探测及测试替身。
该接口只表达运行时资源与生命周期操作：

1. 创建或定位 worktree workspace 与 Agent pane，记录 Herdr 返回的 `workspaceId`、`tabId`、
   `paneId`、Agent 名称、worktree path 和 branch；不得预测资源 ID。
2. 在指定 pane 中调用 `herdr agent start --kind <claude|codex|opencode> -- ...` 启动原生
   Agent，并使用 `agent prompt`、`agent wait`、`agent read`、`agent focus` 与 `pane close`
   协调生命周期。
3. 在 prompt 中注入结果协议。Worker、Reviewer、Integrator 必须把完整角色结果原子写入
   ATeam 指定的结果文件；ATeam 用角色结果 schema 校验文件内容。终端文本与 `idle`、`done`、
   `unknown` 状态均不是完成凭据。
4. 将 Herdr 的 `blocked` 解释为等待用户在原生 UI 中处理的运行时状态。处理完成后，Runner
   再次读取 Agent 状态和结果文件；运行时交互不自动改变交付契约。
5. 仅当结果原子写入、schema 校验通过且任务状态转换已持久化后，关闭成功的临时 pane。
   `blocked`、失败或结果未持久化的 pane 必须保留以供 attach 和接管。
6. 在 Runner pane 中以自定义 Agent 状态报告自身：执行时为 `working`，等待人工交互时为
   `blocked`，持久化最终结论后为 `done` 或 `idle`。任务 Agent 使用 Herdr 官方 integration
   提供的原生状态。

默认使用 Herdr CLI wrapper，保证跨 Unix socket 与 Windows named pipe 的可移植性。仅在需要
长连接事件订阅、原子快照—订阅恢复或低延迟协调时使用 raw socket API。

### 状态、恢复与幂等性

ATeam 持久化 `ExecutionContract`、任务状态、角色结果、复核、验证、提交、不可变策略快照，
以及每个活动执行的 `HerdrExecutionRef`：

```text
run / task / phase / attempt
  -> worktree { path, branch, workspaceId }
  -> terminal { tabId, paneId, agentName, agentKind, model }
  -> native session reference（若 Herdr 提供）
  -> resultFilePath、结果摘要、持久化阶段
```

正常 detach 后，Herdr 中的 Agent 继续运行，Runner 重连后复用同一执行，不得重复发送 prompt。
Herdr server 重启后，插件 startup hook 或显式 `reconcile` 命令必须执行以下流程：

1. 建立事件订阅；
2. 获取 Herdr 权威快照并重连仍有效的 pane、Agent 与 worktree；
3. 读取所有已落盘结果，并补做尚未持久化的状态转换、验证或集成；
4. 只为不存在可恢复执行且没有有效结果的任务创建新的 attempt。

事件流不是可重放的任务日志。ATeam 持久化状态是交付状态的权威来源，Herdr 是运行时资源状态的
权威来源；恢复流程必须先订阅再读取快照，且不得仅根据 pane 是否存在而重复 prompt。

### 临时资源回收

task branch 和对应 worktree 都是单次交付的临时资源。任务通过 Reviewer 后，Integrator 将变更
纳入目标提交；只有该提交、最终机械验证和 ATeam 的集成/提交状态均已持久化，Runner 才可回收
该任务资源。回收顺序固定为：关闭成功 pane、通过 Herdr 移除关联 workspace/worktree、确认没有
其他 worktree 占用该 branch、删除 task branch，最后持久化清理审计记录。

未通过复核、集成失败、`blocked`、Runner 中断或审计记录尚未写入的任务不得回收。reconcile 必须
把已完成集成但未完成回收的资源视为待清理，而不是创建新的 task attempt；每个回收步骤均须可
安全重试。

### Herdr 插件

发布的插件根目录包含 `herdr-plugin.toml`，至少声明：

- `Run team swarm` action：从当前 workspace context 启动或附着 Runner；
- `Reconcile team runs` action：在 server restart、插件启动或人工请求后恢复控制平面；
- `startup` hook：检测未终结 run 并执行无副作用的 reconcile；
- 可选的 run board pane：展示 ATeam 持久化交付状态与跳转链接；
- 可选的 Agent-view 过滤器：优先显示当前 run 中 `blocked` 与 `done` 的 Agent。

Herdr plugin v1 的 action 与 pane entrypoint 是 manifest 静态声明。因此插件只提供固定入口、
上下文和恢复 hook；基于 contract 动态创建的 Agent pane 由 Runner 通过 Herdr API 创建。若
action 的上下文不足以提交 contract，Runner pane 内的命令或上层 Agent 可直接调用 CLI。

## 运行时约束

- 启动前必须探测 Herdr 版本、协议 schema、必需的 `worktree`、`agent`、`session.snapshot`
  和插件能力；版本、API 或原生 integration 不兼容时 fail-fast，并给出修复建议。
- 任务完成始终以通过 schema 校验且已持久化的结果文件为准，不能以 Agent 交互状态替代。
- 影响范围、验收、依赖或路径归属的问题必须通过修订 `ExecutionContract` 解决；原生 pane 交互
  不能扩大既定交付范围。
- 清理只能作用于带有 ATeam provenance 的临时 worktree/workspace 和 task branch；删除 branch
  前必须确认其已集成、无其他 worktree 占用且不属于非 ATeam 资源。清理审计必须保留 branch、
  路径、资源 ID、最终提交和清理结论。
- 插件版本必须声明并固定最小 Herdr 版本；安装与升级视为本地可执行代码变更，需要审查。

## 实施里程碑

1. 定义最低 Herdr 版本、运行时探测、`HerdrExecutionRef` 持久化模型、结果文件协议和
   `agent-team doctor --runtime herdr`。
2. 实现 Runner pane、任务 Agent pane、结构化结果门禁、`blocked` 等待与关闭策略。
3. 接入 Codex、Claude、OpenCode 的原生启动参数，并完成重连、复核重试和集成冲突的端到端流程。
4. 通过 Herdr worktree API 创建、打开和回收任务工作区；在集成、最终验证与提交持久化后删除
   task branch，完成可审计的临时资源生命周期。
5. 发布插件 action、startup hook 和 reconcile 入口，并提供用于 Herdr pane 内调用的 CLI 协议。

## 验证标准

- 两个无依赖任务可在独立 Herdr Agent pane/worktree 中并行完成，Reviewer 使用不同 `agentKind`。
- 任一 Agent 进入原生审批或提问 UI 时，Herdr 和 Runner 均显示 `blocked`；用户接管后任务继续，
  不创建新的 task attempt。
- Agent 显示 `done` 但未写出有效结果文件时，任务不批准，pane 不关闭。
- Agent 写入结果后发生 Runner 崩溃或 Herdr server 重启，`reconcile` 不重复 prompt，只处理未
  持久化的状态转换、验证或集成。
- 成功任务的 pane 仅在结果、复核、验证和 ATeam 状态转换全部持久化后关闭；失败和 `blocked`
  pane 可 attach。
- task worktree、关联 workspace 和 task branch 会在集成、最终验证与提交持久化后依序回收；
  删除及最终提交均可审计，且不会清理非 ATeam 所有资源。
- Herdr 缺失、版本/API 不兼容或 integration 未安装时，蜂群入口明确失败并说明 remediation。

## 参考

- [Herdr Socket API](https://herdr.dev/docs/socket-api/)
- [Herdr Agent automation](https://herdr.dev/docs/agent-automation/)
- [Herdr Session state and restore](https://herdr.dev/docs/session-state/)
- [Herdr Plugins](https://herdr.dev/docs/plugins/)
