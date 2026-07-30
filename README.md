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
- Claude Code、Codex CLI、OpenCode Adapter
- 每个 Worker 独立分支和 Git Worktree
- 依赖任务提交自动注入下游 Worktree
- SQLite WAL 状态库和事件记录
- Worker 并发上限
- 进程 PID、日志心跳、静默超时和硬超时
- Worker 失败自动重试
- 修改路径 allowlist / blocklist 机械校验
- 验证命令前缀 allowlist
- Runner 自己重跑任务验证命令
- Reviewer 审查 staged diff
- 审查驳回后自动把反馈交回 Worker
- Reviewer 批准后由 Runner 创建任务提交
- 按拓扑顺序 cherry-pick 到 integration 分支
- 限定范围的冲突解决 Agent
- 全局验证命令
- Integrator 统一更新架构和进度文档
- 前台运行、后台运行、状态查看和停止

## 环境要求

- Node.js 22.13 或更高版本，推荐 Node.js 24 LTS
- Git
- 至少安装并登录一个 Agent CLI：
  - `claude`
  - `codex`
  - `opencode`

Runner 使用 Node 内置的 `node:sqlite`，无需安装本地 SQLite 原生扩展。

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
.agent-team/config.json
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

默认 `.agent-team/config.json`：

```json
{
  "version": 1,
  "repoRoot": ".",
  "stateDir": ".agent-team",
  "worktreesDir": "../.agent-team-worktrees",
  "baseRef": "HEAD",
  "defaultAdapter": "claude",
  "concurrency": 3,
  "pollIntervalMs": 2000,
  "staleAfterMs": 600000,
  "taskTimeoutMs": 7200000,
  "maxPlanAttempts": 2,
  "maxWorkerAttempts": 2,
  "maxReviewCycles": 2,
  "branchPrefix": "agent-team",
  "verification": {
    "allowedCommandPrefixes": [
      "pnpm test",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm build",
      "npm test",
      "npm run",
      "yarn test",
      "yarn lint",
      "yarn build",
      "bun test",
      "go test",
      "cargo test",
      "make test"
    ],
    "globalCommands": []
  },
  "integration": {
    "allowedPaths": ["specs/**"],
    "runAgentAfterCherryPick": true
  },
  "adapters": {
    "claude": { "command": "claude", "extraArgs": [] },
    "codex": { "command": "codex", "extraArgs": [] },
    "opencode": { "command": "opencode", "extraArgs": [] }
  }
}
```

### 验证命令安全策略

Lead 只能生成以 `allowedCommandPrefixes` 开头的验证命令。Runner 还会拒绝：

- `;`
- `&&`
- `||`
- 管道
- 重定向
- 命令替换
- 多行命令

命令不通过 shell 执行，而是拆分为程序和参数后直接 `spawn`。

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
  --adapter claude
```

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
  --adapter codex
```

### 后台无人值守运行

```bash
agent-team run order-export --detach
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

### 停止

```bash
agent-team stop order-export
```

停止会向当前记录的 Agent PID 发送 `SIGTERM`，并把任务保留为可恢复状态，不删除 Worktree。

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

Runner 重启时，会把遗留的 `running`、`verifying` 和 `reviewing` 任务恢复为 `changes_requested`，保留现有 Worktree 和修改，避免重复创建任务目录。

## Worktree 和依赖

所有任务都从运行的 `baseSha` 创建独立分支。

下游任务开始前，Runner 会把所有已批准的祖先任务提交按拓扑顺序 cherry-pick 到下游 Worktree，并记录新的 `startSha`。因此：

- 下游 Worker 能看到依赖实现
- 下游自己的修改仍然可以单独审查和提交
- 最终 Integrator 只需 cherry-pick 每个任务自己的提交

## Adapter 行为

### Claude Code

使用：

```text
claude -p
--output-format stream-json
--json-schema
--permission-mode dontAsk / acceptEdits
--allowedTools
```

Lead 和 Reviewer 使用只读工具；Worker 和 Integrator允许编辑，并只预批准配置中的验证命令前缀和只读 Git 命令。

### Codex

使用：

```text
codex exec
--json
--sandbox read-only / workspace-write
--ask-for-approval never
--output-schema
```

### OpenCode

使用：

```text
opencode run
--format json
--agent plan / build
--auto
```

OpenCode CLI 当前不由 Runner 强制 JSON Schema，因此 Prompt 会附带 Schema，Runner随后仍执行本地结构校验。

## 安全边界

默认流程不会自动：

- push
- 合并主分支
- 部署
- 修改生产数据库
- 修改云资源
- 执行任意 shell 字符串
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
- 路径 Glob 策略
- blocked path 优先级
- 验证命令安全解析
- SQLite 状态持久化

## 目录结构

```text
src/
  adapters/          Agent CLI Adapter
  core/              SQLite、Git、状态、Prompt、校验和编排
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
- 每任务独立模型和预算
- Token / 成本统计
- 更严格的命令策略 DSL
- 自动生成 Pull Request，但仍要求人工合并
- 容器化 Worker
- 任务取消、暂停和优先级
- SQLite migration 版本管理
- 失败任务的人工修复后继续执行
