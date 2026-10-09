# Herdr 集成协议约束（权威对照表）

herdr 0.9.1（private protocol 22）真机实测校准出的集成约束。改 herdr 集成代码或升级
herdr 版本时，**先对照本表逐条复核**——这些约束全部来自真机失败，单测（fake）测不出来。
逐条结论的固化位置在括号里；复检步骤见文末「升级复检清单」。

## CLI 映射约束（src/herdr/runtime-client.ts）

- API 子命令默认输出 `{id, result}` JSON 信封，**不接受 `--json`**（exit 2）；两段式
  子命令的帮助用 `-h`（`worktree create --help` 会打印顶层帮助）。
- `api snapshot` 结果是 `{type, snapshot:{workspaces,panes,…}}` **双层嵌套**——
  normalizeSnapshot 必须先剥 `snapshot` 键，否则 socket 路径归一化出空快照，reconcile
  会把活资源全判 `resource_lost`（真机踩过）。
- `agent get`：`result.agent` 再嵌一层；缺失 agent 报 `agent_not_found` 错误，必须映射为
  `null`（引擎契约 null = 确定消失，非 not_found 的错误必须传播）。
- `pane report-agent`：位置参数 `<PANE_ID>` + 必填 `--source <ID>`，无 `--pane`；成功
  确认是**空 stdout**（用 callText）。
- `worktree create/open` 必须从仓库**父 workspace**发起，从 task worktree workspace 发起
  会报 "New and open worktree actions start from the repo parent workspace"。
- `agent start` 对启动期进入原生 UI（folder trust、审批对话框）的 agent **即时拒绝**
  （不等 timeout）。runner 侧用 `executions.start_failed` 标记「start 未完成 ⇒ prompt
  必未发送」实现安全重派。真实 agent 冷启动等待给 120s；新 worktree 目录每次都会触发
  claude/codex 的 trust 对话框。
- prompt **无幂等键**：`agent prompt` 的 CLI 与 socket 均无 request-id 字段
  （`AgentPromptParams` 无此参数）。传输层 `supportsPromptDedup() === false`，恢复路径
  对不确定投递必须暂停转人工（R3-01），绝不盲发。**升级 herdr 先查
  `AgentPromptParams` 是否新增了幂等键。**
- codex 0.160 自定义 provider 场景需 `--no-daemon`（config 的 AgentEntry.args）。

## Socket / 事件协议（src/herdr/socket-transport.ts）

- `events.subscribe` 仅接受 **pane 作用域**订阅：每条目必填 `pane_id`；全局订阅报
  `invalid_request`。
- 订阅**类型名用点号且被服务端校验**（白名单含 `workspace.*`/`worktree.created|opened|
  removed`/`tab.*`/`pane.*`，非法名报 `invalid_request`）；混合订阅（pane 类型 +
  worktree 类型同请求）正常 ack，不会整体拒绝。
- **每条连接只有第一个 `events.subscribe` 生效**，后续订阅请求被静默丢弃（无任何响应）。
- 拒绝订阅的错误信封 **`id` 为 `""`**，永远匹配不上请求 id——传输层把无 id 错误信封
  视为本连接订阅被拒，快速失败，而不是烧满 ack 超时。
- 事件载荷在 **`data` 字段**里，类型名两种写法混用：`event` 字段可为点号
  （`pane.agent_status_changed`）或下划线（`pane_closed`）；worktree 事件的
  `data.type` 为下划线（`worktree_created`/`worktree_removed`）。传输层归一为 API 点号
  名（无点则首个下划线转点）。
- `workspace_id` 多在 `data` 顶层；例外：`worktree_created` 嵌在
  `data.workspace.workspace_id`（`data.worktree.open_workspace_id` 兜底）。
  worktree 事件**没有 `pane_id`**——实测按 repo 上下文投递到已存在的 pane 订阅。
- server 重启后 herdr 会恢复**空 pane**（pane 在、agent 进程没了）且**复用小组 id**
  （新 run 的 workspace 又从 w2 开始）。前者要求 reconcile 对存活 pane 再查
  `getAgent`（null ⇒ pane_lost）；后者要求资源台账唯一性必须带 run_id
  （迁移 v6 的 `UNIQUE(run_id, kind, herdr_id)`）。

## 交付模型

- `main` 不动；integration 分支 `ateam/<runId>/integration` 是交付物；cleanup 只删
  task 分支。

## 升级复检清单

1. `bun src/cli.ts doctor --runtime herdr` 全绿（版本 + 能力探测）。
2. 真机事件协议探针：`scripts/herdr-event-probe.ts`（用法见文件头注释；需要 headless
   server `herdr server` + 任一 workspace 的 root pane）。逐条核对上面 Socket/事件
   小节的契约是否仍成立，尤其是：类型白名单、`data` 信封、类型名点号/下划线、每连接
   一个订阅、`id:""` 错误信封、worktree 事件无 `pane_id`。
3. 一个 2 任务最小 e2e（docs/e2e.md 手动清单；`ATEAM_HERDR_E2E=1` 门控的自动用例）。
4. 检查 `AgentPromptParams` 是否新增幂等键（若新增，可重估 R3-01 的暂停语义与
   `supportsPromptDedup()`）。
