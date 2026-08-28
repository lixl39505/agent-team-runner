# Agent Team Runner

一个使用 TypeScript、SQLite 和 Git Worktree 实现的本地多 Agent 编排器。

它把 Agent 的推理能力和确定性控制分开：

```text
初始目标
  ↓
Lead：生成任务 DAG
  ↓
Runner：校验 DAG、创建 Worktree、调度进程
  ↓
Worker：在独立 Worktree 实现单个任务
  ↓
Runner：路径检查、重跑测试、暂存变更
  ↓
Reviewer：审查 staged diff
  ↓
Runner：批准后创建任务提交
  ↓
Integrator：按 DAG 集成、解决限定冲突、更新文档
  ↓
通过完整验证的 integration 分支
```

## 为什么采用 Skill + Prompt

角色行为以 `SKILL.md` 维护，单次运行上下文通过 Prompt 注入：

- Skill 保存稳定、可复用、可版本化的角色流程。
- Prompt 只携带本次 `runId`、任务规格、SHA、反馈和输出 Schema。
- `AGENTS.md` 保存目标仓库自身的长期约束。
- SQLite 状态机、路径策略、测试复跑和 Git 操作由代码执行，不依赖模型遵守 Prompt。

Runner 在调用 Agent 时会直接读取打包的 Skill 内容并编译进运行 Prompt，因此不会依赖模型是否“自动发现”某个 Skill。`agent-team init` 同时把 Skill 同步到：

```text
.agents/skills/       # Codex、OpenCode
.claude/skills/       # Claude Code、OpenCode
```

这些镜像用于手工调用和其他 Agent 会话；Runner 自身仍使用确定性的显式注入。

## 已实现能力

- Lead 自动扫描代码库并生成任务 DAG
- DAG、依赖和循环校验
- 三后端协议级集成：claude（Agent SDK）、codex（app-server JSON-RPC）、opencode（serve + SDK）
- 每个 Worker 独立分支和 Git Worktree
- 依赖任务提交自动注入下游 Worktree
- SQLite WAL 状态库和事件记录
- Worker 并发上限
- 事件流心跳（真实"无进展"检测）、静默超时和硬超时
- Worker 失败自动重试（重试 prompt 嵌入 diff + reviewer 反馈原文 + 上次 summary）
- agents 注册表：为不同 role 配置不同 agent（后端 + model + turn 上限）
- 三后端原生权限请求与 Agent 补充问题统一进入当前终端 FIFO；两类交互使用独立返回协议
- YAML 配置文件 + `-c` 命令行任意层级覆写
- 启动前闭环预检：后端 discover + 真实 model 枚举 + 1-token 试跑（持久缓存）
- 修改路径 allowlist / blocklist 机械校验
- 验证命令前缀 allowlist
- Runner 自己重跑任务验证命令
- Reviewer 审查 staged diff
- 审查驳回后自动把反馈交回 Worker
- Reviewer 批准后由 Runner 创建任务提交
- 按拓扑顺序 cherry-pick 到 integration 分支（集成 worktree 可重跑、幂等）
- 限定范围的冲突解决 Agent
- 全局验证命令
- Integrator 统一更新架构和进度文档
- 前台运行、FIFO 审批队列、状态查看和 Ctrl-C 停止

## 环境要求

- Node.js 22.13 或更高版本，推荐 Node.js 24 LTS
- Git
- 至少安装并登录一个 Agent CLI：
  - `claude`
  - `codex`
  - `opencode`

Runner 使用 Node 内置的 `node:sqlite`，无需安装本地 SQLite 原生扩展。

Runner 支持 macOS、Linux 和 Windows。Windows 子进程通过 `cross-spawn` 启动并用 `taskkill /T /F` 清理进程树。native Windows 默认 fail closed：Claude/OpenCode 没有等价进程 sandbox，Codex 会检查原生 sandbox readiness。需要强隔离时请在 WSL2 中运行。

## 安装

```bash
npm install
npm run build
npm link
```

检查：

```bash
agent-team help
agent-team doctor --repo /path/to/project
```

## 初始化目标仓库

```bash
cd /path/to/project
agent-team init
```

会生成或更新：

```text
.agent-team/config.yml
.agents/skills/team-*/SKILL.md
.claude/skills/team-*/SKILL.md
.gitignore
```

运行数据不会进入 Git：

```text
.agent-team/state.sqlite*
.agent-team/runs/
```

建议把 `templates/AGENTS.snippet.md` 中适用的规则合并到目标项目自己的 `AGENTS.md`。

## 配置

配置文件为 `.agent-team/config.yml`（`agent-team init` 自动生成；加载顺序 `config.yml` > `config.yaml` > 旧版 `config.json`，支持注释；必须声明 `version: 3`）：

```yaml
version: 3

# 常用控制
defaultAgent: default-claude
concurrency: 3
staleAfterMs: 600000
taskTimeoutMs: 7200000
interactionAlert:
  background: '#7C3AED' # human-input prompt background
  foreground: '#FFFFFF' # human-input prompt text

# 仓库与 Worktree
workspace:
  repoRoot: .
  stateDir: .agent-team
  worktreesDir: ../.agent-team-worktrees
  baseRef: HEAD
  branchPrefix: agent-team

# 重试与状态刷新
retry:
  maxPlanAttempts: 2
  maxWorkerAttempts: 2
  maxReviewCycles: 2
status:
  pollIntervalMs: 2000

# 后端接线：CLI 命令缺省用 backend 名本身
backends:
  claude:
    nativeWindowsSandbox: require
  codex:
    nativeWindowsSandbox: require
  opencode:
    nativeWindowsSandbox: require

# agent 注册表：具名 agent = 后端 + model + 选项
agents:
  default-claude:
    backend: claude
  lead-agent:
    backend: codex
    model: gpt-5.6-terra
    description: strong planner
  fast-worker:
    backend: opencode
    model: zhipuai-coding-plan/glm-5.2
  careful-review:
    backend: claude
    model: claude-sonnet-5
    maxTurns: 80 # maxTurns is currently supported by Claude only

# 角色 → agent 名（未配置的角色回退 defaultAgent）
roles:
  lead: lead-agent
  worker: fast-worker
  reviewer: careful-review
  integrator: lead-agent

verification:
  allowedCommandPrefixes:
    - pnpm test
    - pnpm lint
    - pnpm typecheck
    - pnpm build
    - npm test
    - npm run
    - yarn test
    - yarn lint
    - yarn build
    - bun test
    - go test
    - cargo test
    - make test
  globalCommands: []

integration:
  allowedPaths:
    - specs/**
  runAgentAfterCherryPick: true
```

`nativeWindowsSandbox` 仅对 native Windows 生效，取值为：

- `require`：默认值。Claude/OpenCode 因没有等价 sandbox 而拒绝运行；Codex 只有报告 `ready` 时运行。
- `allow-degraded`：显式接受降级。Claude/OpenCode 的命令获批后拥有宿主用户权限；Codex readiness 不可用、未配置或需更新时也继续运行，并打印 warning。

WSL2 运行时属于 Linux 路径，不触发该开关。

### agents 注册表与角色解析

- agent 条目即别名：`model` 绑定在唯一后端上，不再有全局别名表。
- `roles.<role>` 支持注册表名，也支持内联 `backend.model` 规格（如 `-c roles.lead=codex.gpt-5.6-terra` 快速覆写）。
- Lead 的 prompt 会注入 agents 注册表（人工筛选的能力清单）；任务可用 `agent` 字段点名更合适的 agent，plan 后立即校验。
- 各后端真实可用的 model 由预检闭环保证（见下），注册表里的 model 必须真实存在。

### plan 时快照

`plan` 成功后会把角色绑定 + agents 注册表整体固化到 `runs.roles_json`。之后执行 `agent-team run <runId>` 使用快照，不受配置文件后续修改影响。需要人为强制改某个 run 的角色时，用 `-c roles.*=` 覆写（只更新被覆写的角色，其余保留快照）。

### 命令行覆写 `-c`

`-c <path>=<value>` 可重复使用，支持任意层级路径，值先按 JSON 解析（数字/布尔/数组），失败按字符串。优先级：`-c` > 配置文件 > 内置默认值：

```bash
agent-team launch specs/goals/order-export.md \
  -c roles.lead=lead-agent \
  -c roles.reviewer=careful-review \
  -c concurrency=5
```

### 预检闭环（model 可用性验证）

`plan` / `launch` / `run` 启动前会做预检，`doctor` 展示完整结果，`doctor --probe` 强制真实试跑：

- 后端 `discover()`：安装 / 版本 / 认证状态（未安装或未登录 → 阻止启动）
- 后端 `listModels()`：枚举本地登录真实可用的 model（claude `supportedModels()`、codex `model/list`、opencode `/config/providers`）
- 注册表里的 model 不在清单 → 默认阻止启动；此时触发 `probe()`（1-token 真实试跑）仲裁：试跑成功则放行并提示（网关 / 自定义 provider 模型），失败报具体错误
- probe 结果按 (backend, model, backendVersion) 持久缓存于 `.agent-team/preflight-cache.json`，CLI 升级自动失效

不再解析 `~/.codex/config.toml` 或 `~/.claude/settings.json` 之类 dotfile 来"猜测"可用性。

### 验证命令安全策略

Lead 只能生成以 `allowedCommandPrefixes` 开头的验证命令。Runner 还会拒绝：

- `;`
- `&&`
- `||`
- 管道
- 重定向
- 命令替换
- 多行命令
- Git helper / output 重定向参数
- `find -exec/-delete`、`rg --pre` 和构建工具的 helper/path override 参数

命令不通过 shell 执行，而是拆分为程序和参数后直接 `spawn`。验证进程只收到基础环境变量，不会继承 Provider 密钥；每条命令后 Runner 都重新校验 HEAD 和路径。Agent 可以在实现期间自行运行测试，Runner 会在 turn 结束后独立重跑清单中的验证命令。

不要把 `node`、`bash`、`sh`、`python -c` 之类的通用执行器随意放进 allowlist，否则验证命令实际上可以执行任意代码。

## 编写初始目标

参考 `templates/goal.md`：

```md
# 功能目标

实现订单 CSV 导出。

必须包含:

- 后端权限和边界校验
- 前端错误反馈
- 单元测试

明确不实现:

- 异步队列
- Excel 格式
- 部署
```

目标应描述产品边界和验收结果，不需要手工拆任务。

## 使用方式

### 只生成计划

```bash
agent-team plan specs/goals/order-export.md \
  --run-id order-export \
  --agent careful-review
```

`--agent` 设置全局缺省 agent（agents 注册表名）；角色配置了 `roles.<role>` 时优先。

输出：

```text
.agent-team/runs/order-export/manifest.json
.agent-team/runs/order-export/tasks/T001.md
.agent-team/runs/order-export/tasks/T002.md
.agent-team/runs/order-export/logs/lead.log
```

### 执行已有计划

```bash
agent-team run order-export
```

### 一步完成计划和执行

```bash
agent-team launch specs/goals/order-export.md \
  --run-id order-export \
  --agent lead-agent
```

### Ghostty 状态窗格

```bash
agent-team status order-export --watch
```

其他窗格可以直接观察日志：

```bash
tail -f .agent-team/runs/order-export/logs/T001-worker-1.log
tail -f .agent-team/runs/order-export/logs/T001-review-1.log
tail -f .agent-team/runs/order-export/logs/integration-verification.log
```

`plan`、`launch` 和 `run` 都是前台终端命令。运行中使用 Ctrl-C 停止，现场 Worktree 会暂时保留供检查；再次执行 `agent-team run <runId>` 时，Runner 会从任务 `startSha` 重建被中断的 Worktree，并用新会话重跑完整 attempt。

### 终端交互

Claude、Codex 和 OpenCode 的原生权限请求与补充问题统一显示在运行命令所在终端。并发 Agent 的交互进入同一个 FIFO 队列，避免同时读取 stdin：

```text
[Approval] codex / worker / order-export T001 worker
Codex wants to run: npm test
Working directory: /path/to/worktree

[o] once  [s] session  [d] deny:
```

workspace-write 角色在当前 Worktree 内的直接编辑默认允许；命令、网络和外部目录仍使用审批流程。等待审批或回答问题的时间不计入 hard timeout 或 stale timeout。`session` 只在对应后端支持时显示；拒绝会作为原生工具结果返回 Agent，而不是由 Runner 直接判定任务失败。

补充问题不属于授权，不显示 once/session/deny。Claude `AskUserQuestion`、Codex `requestUserInput` 和 OpenCode `question.asked` 会显示选项或自由文本输入，并把答案返回原会话。

## Worker 生命周期

**每任务、每次尝试都是全新会话**。普通失败或 Reviewer 驳回重试时，prompt 会注入厚重试上下文（当前 git diff + reviewer 反馈原文 + 上次 worker summary），Worktree 是这类重试的记忆载体。Ctrl-C/进程异常中断则在下次调度前从 `startSha` 重建 Worktree，不继承半成品 diff。任务间共享知识靠 Integrator 更新的 specs 文档，不靠会话记忆。`maxTurns` 与 `resumeSessionId` 通过后端能力协商：当前只有 Claude 支持；Codex 和 OpenCode 收到这些选项会明确拒绝，不会静默忽略。

## 完成判定

Worker 只能报告“我认为已完成”。最终状态由以下条件共同决定：

```text
Agent 进程正常退出
AND Worker 结构化结果有效
AND 实际修改文件全部符合路径策略
AND Runner 重跑验证命令成功
AND Reviewer 返回 approved
AND Runner 成功创建任务提交
```

只有全部任务 `approved`，并且 integration 分支完成 cherry-pick 和全局验证后，Run 才会进入 `done`。

## 状态流

```text
pending
  ↓
running
  ↓
verifying
  ↓
reviewing
  ├── changes_requested → running
  └── approved

blocked / failed → needs_attention

全部 approved
  ↓
integrating
  ↓
done / failed
```

Runner 重启时，会把遗留的 `running`、`verifying` 和 `reviewing` 任务恢复为 `changes_requested`。再次调度前从 `startSha` 重建其 Worktree，丢弃被中断 attempt 的全部文件修改，再创建新会话；普通 Reviewer 驳回重试仍保留现有 diff。

## Worktree 和依赖

所有任务都从运行的 `baseSha` 创建独立分支。

下游任务开始前，Runner 会把所有已批准的祖先任务提交按拓扑顺序 cherry-pick 到下游 Worktree，并记录新的 `startSha`。因此：

- 下游 Worker 能看到依赖实现
- 下游自己的修改仍然可以单独审查和提交
- 最终 Integrator 只需 cherry-pick 每个任务自己的提交

## 后端与授权闭环

三个后端统一实现 `AgentBackend` 接口（`discover` / `listModels` / `probe` / `openSession`），会话统一产生事件流（消息、工具调用、权限裁决、用量），结构化输出走各后端原生通道：

| 后端 | 集成方式 | 结构化输出 | 权限闭环 |
|---|---|---|---|
| claude | `@anthropic-ai/claude-agent-sdk` | `outputFormat: json_schema` | `canUseTool` 请求 → once/deny；SDK suggestions → session 权限更新 |
| codex | 直连 `codex app-server`（JSON-RPC/stdio，常驻复用） | `turn/start` 的 `outputSchema` | command/file/permissions 请求 → accept/acceptForSession/decline 或 turn/session grant |
| opencode | 受管 `opencode serve` + `@opencode-ai/sdk` | `format: json_schema`（+ prompt 内嵌兜底） | SSE `permission.updated` → once/always/reject |

**codex 协议升级流程**：app-server 协议是 experimental 的，vendored 类型（`src/agent/codex/protocol/`）是针对 `GENERATED_FROM` 记录的版本生成的快照，`agent/codex/` 传输代码窄类型导入其中实际消费的类型。codex 升级后：

```bash
npm run gen:codex   # 重新生成类型 + 写入 GENERATED_FROM 版本标记
npm run check       # 上游破坏性变更在这里变成编译错误，改完即兼容
```

`agent-team doctor` 会比对 `GENERATED_FROM` 与实际安装的 CLI 版本，不一致时提示重新生成。终局方案是等 `@openai/codex-sdk` 补齐审批回调与 model 枚举后切回 SDK（`AgentBackend` 接口即为切换预留）。

Runner 不解析 Agent 命令语义，也不维护网络开关或工具 allowlist。权限分为两层：

1. 后端原生角色边界：Lead/Reviewer 为 read-only，Worker/Integrator 为 workspace-write；网络和额外目录由后端发起审批。
2. Runner 确定性验证：turn 后检查 HEAD 和实际修改路径、重跑验证命令、Reviewer 复查 staged diff，最后才提交。

Read-only 是不可由终端审批提升的角色边界。Workspace-write 会话中的 Bash、网络、编辑和外部目录访问由后端原生权限模型决定，Runner 只展示请求并传回用户选择。`allowedPaths` / `blockedPaths` 仍用于 turn 后机械检查，而不是冒充进程沙箱。

环境变量默认净化：只传 PATH/HOME/LANG 等基础变量和后端认证变量，防止把父进程全部秘密泄漏给能执行命令的 agent。

## 安全边界

默认流程不会自动：

- push
- 合并主分支
- 部署
- 修改生产数据库
- 修改云资源
- 未经后端权限模型和用户授权执行受管操作
- 删除 Worktree

Integration 的默认可写范围只有：

```text
specs/**
```

如果需要自动处理锁文件、全局路由或迁移，必须显式修改配置和目标任务范围。不要为了“无人值守”直接放开整个仓库。

## 测试

```bash
npm test
```

当前包含：

- DAG 校验和拓扑排序
- 路径 Glob 策略与 blocked 优先级
- 验证命令安全解析
- FIFO 终端审批队列与 once/session/deny 映射
- 三后端原生权限编译和协议响应映射
- 监督器全生命周期（成功 / 超时 / 静默 / 审批暂停计时 / 传输异常）
- codex JSON-RPC 帧编解码
- probe 缓存（TTL / 版本隔离）
- agents 注册表解析、v3 配置校验、快照兼容
- YAML 配置加载与 `-c` 覆写
- SQLite 状态持久化

真实后端集成测试分两层（npm script 已带 `--test-force-exit`，见下）：

```bash
npm run test:protocol      # 协议层：discover / model 枚举 / app-server 握手 / thread 生命周期 / opencode serve 启动
                           # 不做任何模型调用——无 token 消耗；codex 升级后先跑这层
npm run test:integration   # 全会话层：真实推理（claude 权限矩阵 spike + codex/opencode 完整 turn）
                           # 需要各 CLI 的本地登录，消耗配额
```

`--test-force-exit` 说明：dispose 后事件循环已被证明排干（handles/requests 均空），但 node:test 的测试子进程在此场景下偶发不触发退出——用官方 flag 收尾，不影响失败检测。opencode 全会话额外需要 `AGENT_TEAM_OPENCODE_SPIKE=1`（本机 provider 挂起，纯 SDK 复现，非集成问题）。

## 目录结构

```text
src/
  agent/             后端层：types / approval / supervise / registry / fake
    claude/          Agent SDK 传输 + policy 编译
    codex/           app-server JSON-RPC 客户端 + policy 编译 + protocol/（生成的协议类型）
    opencode/        serve + SDK 传输 + policy 编译
  core/              SQLite、Git、状态、Prompt、机械校验、编排、preflight
skills/
  team-lead/
  team-worker/
  team-reviewer/
  team-integrator/
templates/
  goal.md
  AGENTS.snippet.md
examples/
test/
```

## 适合继续增加的能力

- Web 控制台和 SSE 日志
- macOS 通知、Slack 或邮件通知
- 每任务独立预算（角色级 model 已支持，见 roles 配置）
- Token / 成本统计
- 自动生成 Pull Request，但仍要求人工合并
- 容器化 Worker
- 任务取消、暂停和优先级
- SQLite migration 版本管理
- 失败任务的人工修复后继续执行
