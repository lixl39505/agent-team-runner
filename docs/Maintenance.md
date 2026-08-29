# Agent Team Runner — Code Execution Reference

本文档从代码执行路径角度说明 agent-team-runner 的完整工作流程，面向需要阅读、维护或扩展此项目的开发者。

## 源码目录与模块职责

```
src/
  cli.ts                  CLI 入口，命令解析与路由
  agent/                  后端层（取代旧 adapters/）
    types.ts              AgentBackend / AgentSession / AgentEvent / SessionSpec / AgentRunOutcome
    approval.ts           FIFO 终端交互队列；权限审批与用户补充问题使用独立协议
    process-tree.ts       POSIX 进程组 / Windows taskkill 进程树终止
    registry.ts           profile-aware backend pool；resolveAgent/snapshotAgents/resolveTaskAgent（取代 profiles.ts）
    supervise.ts          runAgent 监督器：事件泵、日志、心跳、超时/静默、中断与宽限强杀
    fake.ts               脚本化 AgentBackend（单测核心）
    env.ts                子进程环境净化（基础变量 + 后端认证变量 allowlist）
    parse.ts              最终 agent 消息 → JSON 的确定性解析
    claude/
      sdk.ts              @anthropic-ai/claude-agent-sdk 传输（query/canUseTool/outputFormat/supportedModels）
      policy.ts           compileClaude：permissionMode 'default' + read-only 角色边界
    codex/
      jsonrpc.ts          stdio JSON-RPC 客户端（帧编解码纯函数可测）
      app-server.ts       常驻 codex app-server：initialize 握手、thread/turn、审批应答、model/list
      policy.ts           compileCodex：readOnly/workspaceWrite sandbox + untrusted 原生审批
      protocol/           `npm run gen:codex` 生成的协议类型（vendored）
    opencode/
      sdk.ts              自管 opencode serve 子进程 + @opencode-ai/sdk client：session.prompt/SSE 权限应答
      policy.ts           compileOpenCode：服务端原生 ask 门禁 + read-only 角色边界
  core/
    config.ts             配置初始化、加载（YAML/JSON）、v3 默认值合并、-c 覆写
    agent-config.ts       agents 注册表（含 auth profile）校验、backendCommand
    credentials.ts        macOS Keychain API key 存储（service: agent-team-runner）
    terminal-input.ts     交互式 masked secret 输入
    preflight.ts          闭环预检：discover + listModels + probe（按 profile 缓存）
    probe-cache.ts        probe 结果持久缓存（backend:profile|model|version 键，TTL）
    db.ts                 SQLite 状态数据库（runs / tasks / events 三表）
    types.ts              所有类型定义
    prompts.ts            角色 Prompt 模板（lead 注入 agents 注册表、worker 厚重试上下文）
    planner.ts            规划阶段：运行 Lead Agent 生成 DAG
    orchestrator.ts       编排器主循环与单任务执行引擎（后端进程池共享）
    git.ts                Git 操作封装（worktree / cherry-pick / commit / resetWorktree 等）
    verifier.ts           机械验证：路径策略 + 重跑验证命令
    shell.ts              命令安全解析与执行（不允许 shell 元字符）
    path-policy.ts        文件路径 Glob 匹配与 allowlist/blocklist 检查
    status.ts             状态面板格式化
    files.ts              文件读写、Skill 加载与同步、.gitignore 生成
skills/
  team-lead/SKILL.md      Lead 角色行为规范
  team-worker/SKILL.md    Worker 角色行为规范
  team-reviewer/SKILL.md  Reviewer 角色行为规范
  team-integrator/SKILL.md Integrator 角色行为规范
templates/
  goal.md                  目标文件模板
  AGENTS.snippet.md        建议合并到目标项目 AGENTS.md 的规则
```

## 全局控制流

```
agent-team launch goal.md
        │
        ├──→ planRun()          [planner.ts]
        │       ├── 生成 runId
        │       ├── runs 表 INSERT (status=planning)
        │       ├── spawn Lead Agent → 生成 DAG
        │       ├── validateLeadResult() → DAG 校验
        │       ├── tasks 表 INSERT (所有任务)
        │       ├── FS: manifest.json + tasks/*.md
        │       └── runs 表 UPDATE (status=planned)
        │
        └──→ runOrchestrator()  [orchestrator.ts]
                ├── resetInterrupted() → 恢复中断任务
                ├── runs 表 UPDATE (status=running)
                ├── 主循环
                │     ├── 并发槽位计算 (concurrency - active.size)
                │     ├── 筛选可调度任务 (依赖已满足 + 状态为 pending/changes_requested)
                │     ├── 并发 executeTask()
                │     └── Promise.race → 完成一个后重新调度
                ├── (全部 approved)
                └── integrateRun()
                      ├── 创建 Integration Worktree
                      ├── 拓扑顺序 cherry-pick 所有任务提交
                      ├── 冲突时 spawn Integrator 解决
                      ├── 全局验证
                      ├── Integrator finalize → 更新架构/进度文档
                      └── runs 表 UPDATE (status=done)
```

## 阶段 1：初始化 (`agent-team init`)

**入口**：`cli.ts:50-59`

```
1. ensureGitRepo(repoRoot)
   → git rev-parse --show-toplevel 确认是合法仓库

2. initConfig(repoRoot)
   → 如果 .agent-team/config.yml 不存在，写入带注释的 YAML 模板
   → config.ts 的 DEFAULT_CONFIG 定义了全部默认值

3. ensureGitignore(repoRoot)
   → 追加到 .gitignore:
     .agent-team/state.sqlite
     .agent-team/state.sqlite-*
     .agent-team/runs/

4. syncSkills(repoRoot)
   → 从安装目录 skills/ 复制到:
     .agents/skills/team-*/SKILL.md
     .claude/skills/team-*/SKILL.md
```

## 阶段 2：规划 (`planRun`)

**入口**：`planner.ts:16-95`

### 2.1 runId 生成

```typescript
// planner.ts:29
const runId = input.runId
  ?? `${slug(fileStem)}-${timestamp14}`;
```

- `--run-id` 指定 → 原样使用
- 未指定 → `目标文件名(去后缀, 最多40字符, 小写, 非字母数字换-)-YYYYMMDDHHmmss`

### 2.2 数据库初始化

```typescript
// planner.ts:33-40
input.db.createRun({ id: runId, repoRoot, goalFile, baseRef, baseSha, adapter });
```

`db.ts:134-159` 往 `runs` 表插入一行，`status = 'planning'`，同时记录 `RUN_CREATED` 事件。

### 2.3 Lead Agent 调用

```typescript
// planner.ts：经 runAgent 监督器调用（见"Agent 后端层详解"）
const result = await runAgent<LeadResult>({
  backend: backends[leadBinding.backend],
  spec: {
    role: 'lead', cwd: repoRoot,
    prompt: leadPrompt({ goal, goalFile, repoRoot, agents: 注册表清单, ... }),
    schema: LEAD_SCHEMA, model: leadBinding.model,
    access: 'read-only',             // 粗粒度角色边界
    requestApproval,                 // 原生权限请求送到前台 FIFO 队列
    requestUserInput,                // Agent 补充问题送到同一 FIFO 的独立问答协议
    timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs
  },
  logPath, outputPath
});
```

- Lead 的 prompt 模板在 `prompts.ts`：`loadSkill('lead') + 运行上下文 + agents 注册表 + 目标 + 验证命令策略`
- 注册表清单是**人工筛选的能力集合**（name/backend/model/description），Lead 只能从中为任务点名 `agent` 字段
- 结构化输出走后端原生通道（claude `outputFormat` / codex `outputSchema` / opencode `format`），不再 scrape stdout

### 2.4 DAG 校验

`validation.ts:16-29` 对 Lead 输出的 JSON 做多层校验：

```
validateLeadResult(value, validAgentNames)
  ├── version === 1（Number 收敛——schema 侧放宽为 number，模型常输出 "1" 字符串）
  ├── title, summary 非空字符串
  ├── tasks 非空数组
  ├── 每个 task:
  │   ├── id 匹配 /^[A-Z][A-Z0-9_-]{1,31}$/（pattern 同时写进 LEAD_SCHEMA，让 SDK 的 5 次结构化输出重试兜住）
  │   ├── agent 是 agents 注册表中的名字（可选；旧 adapter 字段直接报错要求重新 plan）
  │   ├── allowedPaths/blockedPaths 是相对路径，不含 ..
  │   └── .git 前缀只约束 allowedPaths（blockedPaths 里的 .git/** 是防御性输出，接受）
  ├── validateTaskGraph()
  │   ├── 无重复 task id
  │   ├── 依赖目标都存在
  │   ├── 无自依赖
  │   └── 无环（DFS 检测）
  └── validateParallelPathOwnership()
      └── 无依赖关系的并行任务之间 allowedPaths 不能重叠
```

Lead 最多尝试 `retry.maxPlanAttempts` 次（默认 2）。失败后，错误信息会附加到下一次 prompt 中。

### 2.5 落地

```typescript
// planner.ts:82-88
writeJson(join(runDir, 'manifest.json'), manifest);
for (const task of manifest.tasks) {
  input.db.insertTask(runId, task);
  writeTaskMarkdown(join(runDir, 'tasks', `${task.id}.md`), task, baseSha);
}
input.db.updateRun(runId, {
  status: 'planned',
  manifestJson: JSON.stringify(manifest),
  rolesJson: JSON.stringify(snapshotAgents(input.config))   // 固化 {version:2, roles, agents} 快照
});
```

`writeTaskMarkdown` (`files.ts`) 生成人类可读的任务说明，包含任务元数据（含 task.agent）、目标、变更范围、验证命令、完成标准。

## 阶段 3：主循环 (`runOrchestrator`)

**入口**：`orchestrator.ts:54-121`

### 3.1 启动和恢复

```typescript
// orchestrator.ts:65
db.resetInterrupted(runId);
```

`db.ts:266-281` 将状态为 `running`/`verifying`/`reviewing` 的任务重置为 `changes_requested`：

```sql
SELECT task_id FROM tasks
WHERE run_id = ? AND status IN ('running', 'verifying', 'reviewing')
```

> `resetInterrupted` **只修改 DB，不负责杀进程**。正常前台运行时，SIGTERM/SIGINT/SIGHUP handler 会调用 `disposeBackends`：POSIX 终止整个进程组，Windows 使用 `taskkill /T /F` 终止整个进程树。Ctrl-C 后 Worktree 暂时保留用于检查现场；再次 `run` 时才执行清理。

#### Ctrl-C 后的恢复边界

这里的“恢复”不是恢复模型内存中的执行点，也不调用后端 session resume：

1. 已经 `approved` 的任务保持不变，不重新运行。
2. 当时活跃且尚未 approved 的任务变为 `changes_requested`，本次被中断的 attempt 不计入重试额度。
3. Ctrl-C 返回后，任务 Worktree 暂时保留，便于人工检查中断现场。
4. 下一次 `run` 真正调度该任务时，`ensureTaskWorktree` 删除并从 `startSha` 重建任务 Worktree，丢弃该 attempt 的 tracked、untracked 和 ignored 修改；随后创建全新 Agent 会话，从 Worker 步骤重新执行完整的 Worker → 机械验证 → Reviewer 尝试。
5. 若在 integration 阶段中断，下一次 `run` 会从 `baseSha` 重建 integration Worktree，并按拓扑顺序重新 cherry-pick 所有 approved task commit；不会从半次 cherry-pick 中续跑。

#### invocation、session 与 turn

- **Runner invocation**：一次 `runAgent()` 调用，从 `openSession()` 到结构化 outcome；超时、日志和重试均以此为边界。
- **backend session**：后端会话或 thread。当前每次 Runner invocation 都新建会话；`resumeSessionId` 只是预留字段。
- **provider turn**：后端协议自己的概念，不应作为 Runner 生命周期术语。Claude 一次 query 可包含多个“模型响应 → 工具结果 → 再推理”轮次；Codex 当前每次 invocation 在新 thread 中发起一个 `turn/start`；OpenCode 的一次 `session.prompt` 内部同样可循环调用工具。

因此本文描述 Runner 行为时使用“invocation/调用”；只有说明 Claude `maxTurns` 或 Codex 协议消息时才使用 turn。

### 3.2 核心事件循环

```typescript
const active = new Map<string, Promise<void>>();

while (true) {
  const tasks = db.listTasks(runId);
  const approved = new Set(tasks.filter(t => t.status === 'approved').map(t => t.taskId));

  // 终端状态检查
  if (有 blocked/failed 任务) → runs.status = 'needs_attention', 退出
  if (全部 approved) → 退出循环，进入 integrateRun()

  // 计算空闲槽位
  const slots = Math.max(0, config.concurrency - active.size);

  // 筛选可调度任务
  const candidates = tasks.filter(record => {
    if (record.status 不是 pending 或 changes_requested) → 跳过
    if (active.has(record.taskId)) → 跳过
    if (taskSpec(record).dependsOn 中有未 approved 的) → 跳过
    return true;
  }).slice(0, slots);

  // 并发启动
  for (const candidate of candidates) {
    const promise = executeTask({ config, db, runId, backends, record: candidate })
      .catch(error => db.updateTask(...))  // 异常 → failed
      .finally(() => active.delete(candidate.taskId));
    active.set(candidate.taskId, promise);
  }

  // 等待任意一个任务完成后重新检查调度
  if (active.size > 0) {
    await Promise.race(active.values());
  } else if (有未完成但无法调度的任务) {
    → runs.status = 'needs_attention' (死锁)
  }
}
```

**关键设计**：
- `Promise.race` 而非 `Promise.all`：每完成一个任务立即检查是否有新任务可启动，最大化并发利用率
- 依赖解析在每次循环迭代中重新计算
- 并发槽位 = `concurrency - active.size`，防止超过并发上限

## 阶段 4：单任务生命周期 (`executeTask`)

**入口**：`orchestrator.ts:123-231`

每个任务按严格顺序经历以下 7 个步骤。任一步骤失败触发 `retryOrFail`（第 233-252 行）：未超过 `retry.maxWorkerAttempts`（默认 2）→ `changes_requested`；超过 → `failed`。

### 步骤 1：注入依赖 (`ensureTaskWorktree`)

`orchestrator.ts:254-285`

```
1. 如果 Worktree 已存在：
   - phase 为 `interrupted/recovered` → 从 `startSha` 删除并重建，再复用路径
   - 其他 phase → 直接复用（普通 retry 仍保留 diff 和 Reviewer 反馈）
2. 否则创建:
   repoName = safeSegment(basename(workspace.repoRoot))
   path     = workspace.worktreesDir/repoName/runId/taskId
   branch   = workspace.branchPrefix/runId/taskId
   git worktree add -b <branch> <path> <baseSha>

3. 注入祖先提交:
   收集所有祖先任务 id (递归 dependsOn)
   按拓扑顺序排列
   对每个祖先:
     git cherry-pick <depCommitSha>
     (失败则 abort，抛异常)

4. startSha = currentHead(path)
   DB: 更新 worktree/branch/startSha
```

下游 Worker 因此能在 Worktree 中看到所有依赖任务的代码，但它自己的修改仍然是隔离的。

### 步骤 2：运行 Worker Agent

```typescript
// orchestrator.ts executeTask：后端进程池共享（runOrchestrator 顶部 buildBackends）
const workerBinding = resolveTaskAgent(task, config, run.rolesJson);   // task.agent 优先（连带 model）
const worker = await runAgent<WorkerResult>({
  backend: backends[workerBinding.backend]!,
  spec: {
    role: 'worker', cwd: worktreeInfo.path,
    prompt: workerPrompt({ task, startSha, runId, priorFeedback, retry }),
    schema: WORKER_SCHEMA, model: workerBinding.model, maxTurns: workerBinding.maxTurns,
    access: 'workspace-write',
    requestApproval,                     // 前台 FIFO 审批处理器
    timeoutMs, staleAfterMs,
    onEvent: (event) => { /* 节流 3s 更新 phase 为 'worker-active' */ }
  },
  logPath, outputPath
});
if (!worker.ok || !worker.output) → retryOrFail(...)
```

Worker 的 prompt 模板在 `prompts.ts`：

```
loadSkill('worker')
+ 运行上下文 (runId, startSha)
+ 任务规格 (JSON.stringify(task))
+ 先前的失败或审查反馈 (priorFeedback，可选)
+ 厚重试上下文（retry，可选）：当前 git diff + reviewer 反馈原文 + 上次 worker summary
+ "Runner owns staging and commits. Do not run git add/commit/merge/rebase/push."
```

厚重试上下文由 orchestrator 在普通失败/Reviewer 驳回重试时构造（`collectWorktreeDiff` / `readPreviousSummary`）——
**worktree 是普通重试的记忆载体**：会话每次全新（避免上下文腐烂），但磁盘状态与反馈原文完整注入 prompt。Ctrl-C/进程异常中断是例外：下次调度前从 `startSha` 重建，不向新会话继承半成品 diff。

### 步骤 3：会话监督

`agent/supervise.ts` 的 `runAgent` 为会话设置两层守护，并包装终端交互等待：

| 守护层 | 触发条件 | 动作 |
|--------|---------|------|
| 硬超时 | invocation 的累计有效运行时间超过 `timeoutMs`（默认 2 小时） | `session.interrupt()` → 15s 宽限后 `close()` 强杀 |
| 静默超时 | 连续 `staleAfterMs`（默认 10 分钟）没有任何 `AgentEvent` | 同上 |

- `lastActivity` 在**任何 AgentEvent**（消息增量、工具调用、权限裁决、用量）时重置——"无进展"取代旧"无 stdout"
- `requestApproval` 与 `requestUserInput` 排队和等待期间都暂停 hard/stale 有效时钟；返回后恢复计时
- 用户拒绝作为后端原生工具结果返回；单次或重复拒绝本身不会被 Runner 判定为任务失败
- 被拒绝后 Agent 可以解释、换工具或采取无权限替代方案；最终只有 invocation 失败、Agent 返回 `failed/blocked`，或后续验证失败才会改变任务结果
- 事件以 JSONL 追加到 logPath；结构化输出落盘 outputPath
- 传输异常（completion reject）转为 `ok:false` outcome，走既有 retryOrFail

### 步骤 4：校验 Worker 结果

```typescript
// orchestrator.ts:162-171
const workerResult = validateWorkerResult(worker.output);
if (workerResult.status === 'blocked') → 任务标记 blocked，立即终止
if (workerResult.status === 'failed')  → retryOrFail()
```

`validateWorkerResult` (`validation.ts:153-166`)：

- status 必须在 `['completed', 'blocked', 'failed']` 中
- summary 必须是字符串
- testsRun / knownRisks 必须是字符串数组

### 步骤 5：机械验证 (`verifyTaskWorktree`)

`verifier.ts:14-50`。此步骤**由 Runner 代码自身执行，不通过 Agent**。

```
1. HEAD 不变校验
   currentHead() === startSha ?
   → 防止 Worker 直接 git commit
   → 失败: "Worker changed Git history or committed directly."

2. 文件变更检查
   changedFiles() (git status --porcelain=v1 -z --untracked-files=all)
   → -uall 必需：默认会把整个未跟踪目录折叠成 "src/" 一条，无法匹配文件级 allowedPaths
   → 解析 -z 分隔输出，处理重命名/拷贝
   → if 无修改 && !allowNoChanges → 失败

3. 路径策略检查
   checkPaths(changedFiles, task.allowedPaths, task.blockedPaths)
   → 每个文件: blocked 匹配 → denied
   → 每个文件: allowed 不匹配 → invalid
   → 优先级: blocked > allowed
   → path-policy.ts:33-44

4. 重跑验证命令
   for each verificationCommand:
     assertAllowedCommand(command, config.verification.allowedCommandPrefixes)
     splitCommand(command)              ← 拒绝 ; & | < > ` $()
     assertNoCapabilityBearingArguments ← 拒绝 helper/重定向/路径覆盖参数
     spawn(program, args, verificationEnv) ← 不经 shell，不传 Provider 密钥
     输出写入 verification log
     非零退出码 → 失败
     重新校验 HEAD + changedFiles + path policy
```

命令安全检查 (`shell.ts`)：

- `splitCommand`: 手工解析命令字符串（处理引号、转义），**拒绝任何 shell 元字符**
- `assertAllowedCommand`: 逐 token 与 allowlist 前缀匹配，并拒绝 Git helper/output、`find -exec/-delete`、`rg --pre`、构建工具 helper/path override
- `runCommand`: `spawn(program!, args)` — 不经过 shell

### 步骤 6：Reviewer 审查

```typescript
// orchestrator.ts:183
await stageAll(worktreeInfo.path);  // git add -A
```

Reviewer 的 prompt (`prompts.ts`)：

```
loadSkill('reviewer')
+ 任务规格 (JSON)
+ startSha
+ worktree 绝对路径（显式声明审查目录——实测模型会自己 cd 到主仓库得出错误结论）
+ Worker 报告 (JSON)
+ "The candidate changes are staged by the Runner (git add -A already ran).
   Inspect them with git diff --cached ... Workers never commit ..."
```

Reviewer 以 `access: 'read-only'` 运行：macOS/Linux 上 Claude/Codex 使用原生只读 sandbox；native Windows 上 Claude 硬拒绝 Bash；OpenCode 在所有平台对 Bash/Edit 硬拒绝。下方的 Git 状态快照提供独立兜底。

**安全校验** — Reviewer 不能修改任何东西 (`orchestrator.ts:200-206`)：

```typescript
const headBefore  = await currentHead(worktreeInfo.path);
const statusBefore = await git(worktreeInfo.path, ['status', '--porcelain=v1', '-z']).stdout;
// ... 调用 Reviewer ...
const headAfter  = await currentHead(worktreeInfo.path);
const statusAfter = await git(worktreeInfo.path, ['status', '--porcelain=v1', '-z']).stdout;

if (headAfter !== headBefore || statusAfter !== statusBefore) {
  await unstageAll(worktreeInfo.path);  // git reset
  → 失败: "Reviewer modified Git state or files."
}
```

Reviewer 输出校验 (`validation.ts:168-190`)：

- decision 必须在 `['approved', 'changes_requested']` 中
- findings 数组：每条包含 severity/critical/high/medium/low、file、message、(line)
- requiredChanges 必须是字符串数组

### 步骤 7：提交或重试

```typescript
// orchestrator.ts:226-231
if (review.decision === 'approved') {
  const commitSha = await commit(worktreeInfo.path, `[${task.id}] ${task.title}`);
  // git add -A && git commit -m "message"
  db.updateTask(runId, task.id, { status: 'approved', commitSha });
} else {
  // changes_requested
  await unstageAll(worktreeInfo.path);        // git reset
  if (reviewCycle >= retry.maxReviewCycles) → failed
  else {
    db.updateTask(runId, task.id, {
      status: 'changes_requested',
      lastError: reviewFeedback(review)        // 摘要 + requiredChanges + findings
    });
  }
}
```

**只有 Reviewer 说 approved 时 Runner 才执行 git commit。Worker 永远不能自己做 commit。**

`reviewFeedback` (`prompts.ts:95-101`) 将审查结果压缩为文本，作为下一轮 Worker 的 `priorFeedback` 注入 prompt。

## 阶段 5：集成 (`integrateRun`)

**入口**：`orchestrator.ts:299-382`

### 5.1 创建 Integration Worktree

```typescript
// orchestrator.ts integrateRun 顶部
const worktree = join(config.workspace.worktreesDir, repoName, safeSegment(runId), 'integration');
const branch = `${config.workspace.branchPrefix}/${safeSegment(runId)}/integration`;
// resetWorktree：集成 worktree 是一次性的——无论上次集成停在什么状态（脏文件/冲突/
// cherry-pick 中断），都强制清掉 worktree 与分支、从 baseSha 重建（git.ts，幂等可重跑）
await resetWorktree({ repoRoot, path: worktree, branch, baseSha: run.baseSha });
db.updateRun(runId, { integrationBranch: branch, integrationWorktree: worktree });
```

### 5.2 Cherry-pick 所有任务

```typescript
// orchestrator.ts:317-354
for (const task of topologicalTasks(manifest.tasks)) {
  const record = db.getTask(runId, task.id);
  const picked = await cherryPick(worktree, record.commitSha);

  if (picked.code === 0) continue;

  // 冲突 → Integrator 解决
  const conflicts = await conflictedFiles(worktree);
  // git diff --name-only --diff-filter=U -z

  const conflictResult = await runAgent<IntegrationResult>({
    backend: integratorBackend,
    spec: {
      role: 'integrator',
      prompt: integrationPrompt({ mode: 'resolve_conflict', worktreePath: worktree, conflictFiles: conflicts }),
      access: 'workspace-write', requestApproval,
      ...
    }
  });

  // 安全校验
  const conflictChanges = await changedFiles(worktree);
  const conflictPolicy = checkPaths(conflictChanges, conflicts, []);
  // Integralor 只能改冲突文件，不能改其他文件

  await stageAll(worktree);
  const unresolved = await conflictedFiles(worktree);
  // 所有冲突必须已解决
  await git(worktree, ['cherry-pick', '--continue']);
}
```

### 5.3 全局验证

```typescript
// orchestrator.ts:356
await runGlobalVerification({ worktree, config, logPath });
```

`verifier.ts:52-65`：仅执行 `config.verification.globalCommands`（默认为空数组）。

### 5.4 Integrator 最终处理

```typescript
// orchestrator.ts integrateRun 尾部
if (config.integration.runAgentAfterCherryPick) {
  const integrationRun = await runAgent<IntegrationResult>({
    backend: integratorBackend,
    spec: {
      role: 'integrator',
      prompt: integrationPrompt({ manifest, integrationAllowedPaths, mode: 'finalize', worktreePath: worktree }),
      access: 'workspace-write', requestApproval,
      ...
    }
  });

  // 路径检查
  const files = await changedFiles(worktree);
  const policy = checkPaths(files, config.integration.allowedPaths, []);
  // 默认 allowedPaths: ['specs/**']

  await runGlobalVerification({ worktree, config, ... });
  await stageAll(worktree);
  await commit(worktree, '[integration] update architecture and progress documentation');
}
```

Integrator finalize 的 prompt (`prompts.ts:73-93`)：

```
loadSkill('integrator')
+ mode: 'finalize'
+ "Inspect the integrated result. Update architecture/progress documentation
   only when warranted. You may modify only: specs/**"
+ 完整 RunManifest (JSON)
```

Integrator 输出校验 (`validation.ts:192-204`)：

- status 必须在 `['completed', 'blocked', 'failed']` 中
- documentationUpdated 必须是字符串数组

### 5.5 完成

```typescript
// orchestrator.ts:378-381
const integrationCommit = await currentHead(worktree);
db.updateRun(runId, {
  status: 'done',
  integrationCommit,
  error: null,
  finishedAt: new Date().toISOString()
});
writeFileSync(join(runDir, 'summary.txt'), `...`, 'utf8');
```

## agents 注册表与角色解析

### config v3 三层结构

```yaml
version: 3
workspace:                   # 仓库与 Worktree
  repoRoot: .
  stateDir: .agent-team
retry:                       # 重试上限
  maxWorkerAttempts: 2
backends:                    # 传输层接线
  claude: { nativeWindowsSandbox: require }
  codex: { command: codex, nativeWindowsSandbox: require }
  opencode: { nativeWindowsSandbox: require }
agents:                      # 人工筛选的 agent 注册表
  lead-agent:     { backend: codex, model: gpt-5.6-terra, description: strong planner, maxTurns: 80 }
  fast-worker:    { backend: opencode, model: zhipuai-coding-plan/glm-5.2 }
roles:                       # role → agent 名
  lead: lead-agent
  worker: fast-worker
defaultAgent: <注册表名>     # 未配置角色的回退
```

- 自定义 `agents:` 整体替换默认注册表；用户未显式指定 `defaultAgent` 时自动取注册表第一个条目。
- `roles.<role>` 也接受内联 `<backend>.<model>` 规格（`-c roles.lead=codex.gpt-5.6-terra` 快速覆写）。
- `backends.<id>.nativeWindowsSandbox` 仅影响 native Windows：`require`（默认）要求等价 sandbox，`allow-degraded` 是用户明确选择的宿主权限降级。WSL2 作为 Linux 运行，不触发该策略。

### 角色解析回退链（`agent/registry.ts`）

```
roles.<role> 是注册表名   → 该 agent 条目（backend + model + maxTurns）
roles.<role> 是内联规格   → 解析 backend.model
未配置                    → defaultAgent
```

### plan 快照（`snapshotAgents` / `resolveAgentWithSnapshot`）

- `planRun` 成功后把 `{version: 2, roles: 全部角色绑定, agents: 注册表}` 整体写入 `runs.roles_json`——这是独立于 config.yml 的 AgentSnapshot 版本；run 对配置文件后续变化完全 hermetic（含 task.agent 引用的 agent 定义）。
- `parseSnapshot` 兼容旧 v1 快照形状（`{cli, model}` 逐角色翻译）。
- `agent-team run <id> -c roles.worker=...` 人为强制修改：只更新被覆写的角色，其余保留快照（`cli.ts` run 分支）。

### 优先级总览

```
Worker agent 选择:  task.agent（Lead manifest，注册表名，连带 model/maxTurns） > worker 角色绑定 > defaultAgent
Lead/Reviewer/Integrator: 角色绑定 > defaultAgent
配置值优先级:     -c 命令行 > config.yml > config.yaml > config.json > 内置默认
```

### 配置加载（`config.ts`）

- 文件优先级：`.agent-team/config.yml` > `config.yaml` > `config.json`（首个存在者）。
- YAML 用 `yaml` npm 包解析；JSON 走 `JSON.parse`。
- `applyOverrides(config, entries)` 处理 `-c path=value`：按 `.` 逐层写入，值先尝试 `JSON.parse`（数字/布尔/JSON 结构），失败按字符串。
- `initConfig` 生成带注释的 v3 `config.yml` 模板（含 agents/roles 示例）。

### 预检闭环（`core/preflight.ts`）

`plan`/`launch`/`run` 启动前执行，`doctor` 展示完整结果，`doctor --probe` 强制真实试跑：

| 检查项 | 结果 |
|--------|------|
| agents 注册表语法 / roles 引用 / defaultAgent（`validateAgents`） | error，阻止启动 |
| 后端 `discover()`：未安装 / 未认证 | error，阻止启动 |
| 后端 `listModels()` 枚举真实可用 model | 枚举失败 → warning，退化到 probe 仲裁 |
| 注册表 model 不在清单 → `probe()` 1-token 真实试跑 | 试跑失败 → error；成功 → warning（网关/自定义模型放行） |
| probe 结果按 (backend, model, backendVersion) 持久缓存（`probe-cache.ts`，TTL 24h） | CLI 升级自动失效 |

model 枚举来源：claude `Query.supportedModels()`、codex app-server `model/list`、opencode `GET /config/providers`。不再解析 `~/.codex/config.toml` / `~/.claude/settings.json`。

`run` 命令的预检基于 runs 表快照 + manifest 中出现的 task.agent，而非当前配置文件。

## Agent 后端层详解

### 接口定义

`agent/types.ts`：

```typescript
export interface AgentBackend {
  readonly id: BackendId;                                   // 'claude' | 'codex' | 'opencode'
  discover(): Promise<DiscoveryResult>;                     // installed / version / authed
  listModels(): Promise<ModelInfo[]>;
  probe(model?: string): Promise<ProbeResult>;              // 1-token 真实试跑
  openSession(spec: SessionSpec): Promise<AgentSession>;
}

export interface SessionSpec {
  role: AgentRole; label?: string; cwd: string; prompt: string;
  schema: object;                                           // 结构化输出 JSON Schema
  model?: string; access: 'read-only' | 'workspace-write';  // 不可提升的角色边界
  requestApproval?: ApprovalHandler;                        // once/session/deny
  requestUserInput?: UserInputHandler;                      // question id -> string[]
  timeoutMs: number; staleAfterMs: number; maxTurns?: number;
  resumeSessionId?: string;                                 // 实验开关预留
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentSession {
  readonly sessionId?: string;
  interrupt(): Promise<void>;
  close(): Promise<void>;                                   // 可重入
  completion(): Promise<AgentRunOutcome>;
}

export interface AgentRunOutcome<T> {
  ok: boolean; output: T | null; error?: string;
  timedOut: boolean; stalled: boolean;
  sessionId?: string; usage?: { inputTokens?; outputTokens? };
}
```

`AgentEvent` 联合：`activity | session | message | tool-call | tool-result | permission-check | usage`——事件流同时驱动心跳、日志与静默判断。回答用户问题后适配器发出 `activity`；等待答案期间监督时钟已暂停。

### 工厂与进程池

`agent/registry.ts:buildBackends(config)` 实例化三后端。`runOrchestrator` 顶部构建、整个 run 共享（codex app-server / opencode serve 常驻复用），finally 与 SIGTERM/SIGINT 时 `disposeBackends`；`planRun` 独立构建并在结束时释放。

### 监督器（`agent/supervise.ts:runAgent`）

`openSession`（包装 onEvent：记日志 + 重置静默计时 + 转发；包装 requestApproval/requestUserInput：暂停有效时钟）→ 并发跑 `completion()` 与两层守护（硬超时 / 静默超时，均 `interrupt()` + 15s 宽限后 `close()` 强杀）→ `close()` → 结构化输出写 outputPath。传输异常转为 `ok:false` outcome。审批和问答的排队/等待墙钟时间不计入 hard/stale timeout。

### 终端交互与原生权限路由（`agent/approval.ts` + 各后端 policy.ts）

Runner 只传递 `read-only | workspace-write` 角色边界，不实现通用 Bash 解析、路径实时裁决或网络开关。后端产生的所有终端交互由共享 `ApprovalQueue` 串行显示，避免并发任务争抢 stdin，但交互契约分开：

- 权限请求返回 `once | session | deny`，由适配器映射为后端原生裁决。
- 补充问题返回 `Record<questionId, string[]>`，没有“本次/本会话授权”语义。Claude `AskUserQuestion`、Codex `item/tool/requestUserInput`、OpenCode `question.asked` 均接入该通道。
- Codex MCP elicitation 不是 Agent 补充问题，当前显式 decline；后续需要单独实现 schema-aware form renderer，不能把它当普通文本问题接受。

| 后端 | sandbox | in-flight 裁决 | 说明 |
|---|---|---|---|
| claude | macOS/Linux 使用 SDK sandbox：`failIfUnavailable`、禁止 unsandboxed、只读角色 deny cwd；Git metadata denyWrite | `canUseTool` → allow/deny；session 选择把 SDK suggestions 的 destination 改为 session | workspace 内 Edit/Write/NotebookEdit 默认 allow；外部路径、Bash、网络仍走原生 ask |
| codex | `sandboxPolicy`：readOnly / workspaceWrite(writableRoots=[cwd], networkAccess=false) | command → accept/acceptForSession/decline；permissions profile → turn/session grant | workspace 内 file change 默认 accept；额外目录和网络仍审批；只读角色不授予写权限 |
| opencode | 无进程 sandbox；read-only 角色硬拒绝 Bash/Edit | SSE permission.updated → once/always/reject | workspace 内 edit 由 Runner 自动 once；Bash/Web/external_directory 仍审批 |

安全读工具按**明确工具名**预授权，不对 MCP/custom tool 使用通配符：Claude 为 `Read/Glob/Grep/LSP/TaskGet/TaskList/TaskOutput`；OpenCode 为 `read/glob/grep/list/lsp/skill/todoread/todowrite/question`；Codex 不使用工具名 allowlist，而由原生 sandbox 限制能力。网络读取不属于安全本地读取，仍需审批。

`allowedPaths` / `blockedPaths` 不参与 in-flight 审批。它们在 Agent invocation 完成后由 `verifier.ts` 检查实际 Git 变更；Reviewer 的只读 sandbox 和前后 Git fingerprint 提供另一条独立边界。

### 平台能力矩阵

| 平台 | 子进程启动/清理 | 后端隔离 |
|---|---|---|
| macOS | `cross-spawn`；独立进程组 SIGTERM → 3s 后 SIGKILL | Claude/Codex 使用各自 macOS sandbox；OpenCode 无进程 sandbox |
| Linux | `cross-spawn`；独立进程组 SIGTERM → 3s 后 SIGKILL | Claude/Codex 使用各自 Linux sandbox，缺少内核/工具能力时 fail closed；OpenCode 无进程 sandbox |
| Windows | `cross-spawn` 兼容 `.cmd`/shebang；`taskkill /T /F` 清理整棵进程树 | 默认 `nativeWindowsSandbox: require` fail closed：Codex 检查 native readiness，Claude/OpenCode 因无等价 sandbox 拒绝运行；只有显式 `allow-degraded` 才允许降级 |

三平台都能运行 Runner，但“兼容”不代表隔离强度相同。`allow-degraded` 时，native Windows 上 Claude/OpenCode 的获批命令具有宿主用户权限；Codex 的 readiness 为 `notConfigured`、`updateRequired` 或查询失败时也会降级。native Windows 上需要 Claude 的完整命令 sandbox 时应在 WSL2 中运行；OpenCode 在所有平台上如需强进程隔离，应放入容器或其他外层 sandbox。路径策略已统一把 `\\` 归一化为 `/`。

### claude 后端（`agent/claude/sdk.ts`）

- `@anthropic-ai/claude-agent-sdk` 的 `query()`：`outputFormat {type:'json_schema'}` 结构化输出、`includePartialMessages`（delta 事件喂静默计时）、`abortController` + `Query.interrupt()`、`maxTurns`。
- `listModels()` 经 `supportedModels()`（value + resolvedModel 别名都算命中）；`probe()` 用 maxTurns=1 的微型 turn。
- SDKMessage→AgentEvent 映射与 result 映射是纯函数（`mapClaudeMessage` / `mapClaudeResult`）。
- 环境变量经 `agent/env.ts:sanitizedEnv` 净化。

### codex 后端（`agent/codex/`）

- `jsonrpc.ts`：stdio 换行分隔 JSON 客户端，帧编解码 `parseFrames` 纯函数可测；服务端主动请求异步应答；POSIX 进程以独立进程组 spawn，`close()` 进程组 SIGTERM → **ref'd** 3s SIGKILL 升级，Windows 使用 `taskkill /T /F`。
- `app-server.ts`：常驻 `codex app-server` 子进程；native Windows 预检调用 `windowsSandbox/readiness`，结果为 `ready` 才满足默认策略；`notConfigured`、`updateRequired` 或协议查询失败只有在显式 `allow-degraded` 时继续。随后 `thread/start`（cwd/model/approvalPolicy/sandbox）→ `turn/start`（input 文本 + `outputSchema` + per-turn 覆盖）；通知路由：`turn/completed`→完成、`item/completed`（agentMessage/commandExecution）→事件、`item/*/delta`→activity、`thread/tokenUsage/updated`→usage；command/file/permissions 审批与 `item/tool/requestUserInput` 问答请求异步等待终端决定。
- `protocol/` 是 `npm run gen:codex`（`codex app-server generate-ts`）生成的 vendored 类型；`protocol/GENERATED_FROM` 记录生成时的 CLI 版本，`agent/codex/generated.ts` 在 doctor 中与实际版本比对（不一致 → warn 提示重新生成）。`app-server.ts` / `policy.ts` 窄类型导入实际消费的协议类型（`TurnStartParams`、`SandboxPolicy`、审批 params/response、通知载荷、`ModelListResponse` 等，均为 `import type` 零运行时耦合）——上游破坏性变更在 `npm run check` 直接变成编译错误，升级流程是机械的 `gen:codex` → `check` → 集成测试。

### opencode 后端（`agent/opencode/sdk.ts`）

- **自管 `opencode serve` 子进程**：自己 spawn（支持 `backends.opencode.command` 覆盖、自选端口、解析 "listening on" 行就绪）+ 只用 SDK 的 `createOpencodeClient({baseUrl})` 连接。不使用 SDK 的 `createOpencode()` 托管模式——其 server 关闭是黑盒（实测残留未销毁的 stdio 管道句柄，宿主进程无法退出）且硬编码命令名。
- dispose：终结 SSE 订阅流 → 销毁 server 子进程 stdio 流 → POSIX 进程组终止或 Windows `taskkill /T /F`（与 codex jsonrpc 同语义）。
- `session.create`（directory=cwd）→ `session.prompt`（parts 文本 + model `{providerID, modelID}` + `format {type:'json_schema', retryCount}`，SDK 类型滞后于服务端故用 cast；prompt 同时内嵌 schema 兜底）；响应取 `info.structured` 优先，退回 parts 文本经 `parseAgentJson` 解析。
- provider 错误（如 401）在 `info.error`——显式转为失败 outcome 并透出明细。

### JSON 解析（`agent/parse.ts:parseAgentJson`）

确定性三层：`JSON.parse` 整文 → 最后一个 markdown code fence → 从最后一个 `{` 截取。仅用于 codex/opencode 的最终消息通道（claude 走原生 structured_output）。旧 `parseJsonLoose` 五层猜测解析已删除。

## 命令安全模型

### 白名单校验

`shell.ts:28-36` `assertAllowedCommand`：

```typescript
1. splitCommand(command) → tokens[]
2. 对每个 allowlist 前缀，逐 token 比对
3. 必须存在一个前缀与命令的前 N 个 token 完全匹配
```

允许的前缀示例：
```
pnpm test
npm run
go test
cargo test
```

### Shell 注入防护

`shell.ts:3-26` `splitCommand` — 拒绝以下所有内容：

```
; & | < > ` ^       shell 控制/重定向/Windows 转义操作符
$()                 命令替换
\n \r               多行命令
```

命令执行**不经过 shell**：`spawn(program, args)` 直接执行（`shell.ts:41`）。

### 通用执行器风险

配置警告（来自 README）：

> 不要把 `node`、`bash`、`sh`、`python -c` 之类的通用执行器放进 allowlist，否则验证命令可以执行任意代码。

## 路径安全模型

### Glob 匹配

`path-policy.ts:7-31` `globMatch` — 将 glob 模式转为正则：

```
*      → [^/]*
**     → .*
**/    → (?:.*/)?
?      → [^/]
其他    → 转义
```

约束：
- 所有模式必须是相对路径
- 不允许 `..`（防路径穿越）
- 不允许 `.git/` 前缀

### 路径检查

`path-policy.ts:33-44` `checkPaths`：

```
for each 修改的文件:
  if 匹配任意 blocked glob → denied
  if 不匹配任意 allowed glob → invalid

return { ok: denied 和 invalid 都为空 }
```

优先级：**blocked > allowed**。如果一个文件既匹配 allowed 又匹配 blocked，它会被拒绝。

### 并行任务路径冲突检测

`validation.ts:113-151` `validateParallelPathOwnership`：

- 对每对无依赖关系的任务
- 检查它们的 `allowedPaths` 是否可能重叠
- 重叠则报错："添加依赖或缩小路径范围"

## 状态机

### Run 状态

`types.ts:4-12`

```
planning → planned → running → needs_attention / integrating → done / failed
```

### Task 状态

`types.ts:14-22`

```
pending → running → verifying → reviewing → approved
                 ↓              ↓
          blocked / failed   changes_requested → running（重试）
```

### 恢复逻辑

Runner 重启时 (`db.ts:266-281` `resetInterrupted`)：

```
任务状态为 running/verifying/reviewing
    → 重置为 changes_requested
    → phase = 'recovered'
    → lastError = 'Runner restarted while the task was active...'
    → 暂时保留 worktree，供人工检查现场
```

`ensureTaskWorktree` 检测到 `interrupted/recovered` phase 时，调用 `resetWorktree` 从 `startSha` 删除并重建任务 Worktree，然后启动全新 Worker 会话；其他普通重试继续复用已有 Worktree，以保留 Reviewer 反馈对应的 diff。

## 数据库 Schema

`db.ts:76-131`，三张表：

### runs

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  goal_file TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  adapter TEXT NOT NULL,
  status TEXT NOT NULL,
  manifest_json TEXT,
  roles_json TEXT,
  integration_branch TEXT,
  integration_worktree TEXT,
  integration_commit TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
```

### tasks

```sql
CREATE TABLE tasks (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT,
  branch TEXT,
  worktree TEXT,
  start_sha TEXT,
  commit_sha TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  review_cycles INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  review_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (run_id, task_id),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
) STRICT;
```

### events

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
) STRICT;
```

数据库以 WAL 模式运行 + `busy_timeout = 5000` + `foreign_keys = ON`。

Schema 迁移（`db.ts:addColumnIfMissing`）：构造时用 `PRAGMA table_info` 检查列是否存在，缺失则 `ALTER TABLE ADD COLUMN` 幂等补齐（当前用于 runs.roles_json）。

## 文件系统布局

```
<project>/
  .agent-team/
    config.yml
    state.sqlite
    state.sqlite-wal
    state.sqlite-shm
    runs/
      <runId>/
        manifest.json
        summary.txt
        lead-result-<attempt>.json
        tasks/
          T001.md
          T002.md
        logs/
          lead-<attempt>.log
          T001-worker-<attempt>.log
          T001-review-<cycle>.log
          T001-verification-<attempt>.log
          integration-verification.log
          integration-verification-after-docs.log
          integration-conflict-<taskId>.log
          integrator.log
        results/
          T001-worker-<attempt>.json
          integrator.json
          integration-conflict-<taskId>.json
        reviews/
          T001-review-<cycle>.json

../.agent-team-worktrees/<repoName>/<runId>/
  T001/             ← Worker T001 独立 Worktree
  T002/             ← Worker T002 独立 Worktree
  integration/      ← Integrator 合并 Worktree

Git 分支:
  agent-team/<runId>/T001
  agent-team/<runId>/T002
  agent-team/<runId>/integration
```

## 测试分层

```
npm test                  # 单元与本地 CLI 测试；无真实模型调用、无网络、无后端密钥
npm run test:protocol     # 协议层集成（AGENT_TEAM_PROTOCOL=1）：discover / model 枚举 /
                          # app-server 握手与 thread 生命周期 / opencode serve 启动——零推理零 token
npm run test:integration  # 全会话层（AGENT_TEAM_INTEGRATION=1）：真实推理，需要各 CLI 本地登录
```

- `.github/workflows/ci.yml` 在 `ubuntu-latest`、`macos-latest` 与 `windows-latest` 运行 `npm test`。
- Windows 路径 tokenization 和 sandbox 降级策略是可在任意平台执行的纯单元测试；`taskkill /T /F` 后代清理测试仅在 Windows 执行，其他平台显式 skip。
- Codex readiness 的 `ready/notConfigured/updateRequired` 映射是纯单元测试；对真实 Codex app-server 的 readiness 请求在 Windows CI 不执行，因为 CI 没有登录的 Codex CLI。用户机器上的 `doctor`、`plan`、`launch` 与 `run` 预检会执行真实查询。

- 两个集成 script 自带 `--test-force-exit`：dispose 后事件循环已排干（handles/requests 均空的诊断结论），但 node:test 子进程在此场景偶发不退出，官方 flag 只影响收尾不影响失败检测。
- opencode 全会话额外需要 `AGENT_TEAM_OPENCODE_SPIKE=1`（本机 provider 挂起，纯 SDK 复现，非集成问题）。
- codex 升级验证顺序：`npm run gen:codex` → `npm run check`（窄类型导入让破坏性变更变成编译错误）→ `npm run test:protocol` → 需要时 `npm run test:integration`。

## 前台运行与终止

`plan`、`launch` 和 `run` 要求交互终端，因为任一后端都可能在 invocation 中发起权限请求或补充问题。Ctrl-C 触发 `disposeBackends`，释放当前 Runner 的 Agent 会话和子进程树；现场 Worktree 暂时保留。下次 `run` 调度未完成任务前从 `startSha` 重建其 Worktree，并使用新会话重跑；integration 从 `baseSha` 重建。
