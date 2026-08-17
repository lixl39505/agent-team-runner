# Agent Team Runner — Code Execution Reference

本文档从代码执行路径角度说明 agent-team-runner 的完整工作流程，面向需要阅读、维护或扩展此项目的开发者。

## 源码目录与模块职责

```
src/
  cli.ts                  CLI 入口，命令解析与路由
  adapters/
    index.ts              根据 AdapterName 创建对应的 AgentAdapter 实例
    types.ts              AgentAdapter 接口定义
    process.ts            spawn Agent 进程，超时/静默监控，JSON 解析
    claude.ts             Claude Code CLI adapter
    codex.ts              Codex CLI adapter
    opencode.ts           OpenCode CLI adapter
  core/
    config.ts             配置初始化、加载（YAML/JSON）、默认值合并、-c 覆写
    profiles.ts           Agent Profile 解析（cli.model）、角色回退、快照
    codex-config.ts       codex config.toml 子集解析 + model 静态校验
    claude-config.ts      claude settings.json 解析 + model 静态校验
    preflight.ts          启动前预检：CLI 可用性 + 各 CLI 的 model 校验
    db.ts                 SQLite 状态数据库（runs / tasks / events 三表）
    types.ts              所有类型定义
    prompts.ts            角色 Prompt 模板（lead/worker/reviewer/integration）
    planner.ts            规划阶段：运行 Lead Agent 生成 DAG
    orchestrator.ts       编排器主循环与单任务执行引擎
    git.ts                Git 操作封装（worktree / cherry-pick / commit 等）
    verifier.ts           机械验证：路径策略 + 重跑验证命令
    shell.ts              命令安全解析与执行（不允许 shell 元字符）
    path-policy.ts         文件路径 Glob 匹配与 allowlist/blocklist 检查
    status.ts              状态面板格式化
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
// planner.ts:56-63
const result = await adapter.run<LeadResult>({
  role: 'lead',
  cwd: repoRoot,
  prompt: leadPrompt({ goal, goalFile, repoRoot, ... }),
  schema: LEAD_SCHEMA,
  logPath: join(runDir, 'logs', `lead-${attempt}.log`),
  outputPath: join(runDir, `lead-result-${attempt}.json`),
  timeoutMs: config.taskTimeoutMs,
  staleAfterMs: config.staleAfterMs
});
```

- Lead 的 prompt 模板在 `prompts.ts:4-31`：`loadSkill('lead') + 运行上下文 + 目标`
- `loadSkill` (`files.ts:29-32`) 从安装目录 `skills/team-lead/SKILL.md` 读取，**去掉 YAML frontmatter**，内容直接拼接到 prompt
- Lead 以只读模式运行（`--permission-mode dontAsk`，仅 Read/Glob/Grep/只读 Git 工具），不允许修改仓库文件

### 2.4 DAG 校验

`validation.ts:16-29` 对 Lead 输出的 JSON 做多层校验：

```
validateLeadResult()
  ├── version === 1
  ├── title, summary 非空字符串
  ├── tasks 非空数组
  ├── 每个 task:
  │   ├── id 匹配 /^[A-Z][A-Z0-9_-]{1,31}$/
  │   ├── adapter 在 ['claude', 'codex', 'opencode'] 中（可选）
  │   ├── allowedPaths/blockedPaths 是相对路径，不含 .. 或 .git
  │   └── verificationCommands 是字符串数组
  ├── validateTaskGraph()
  │   ├── 无重复 task id
  │   ├── 依赖目标都存在
  │   ├── 无自依赖
  │   └── 无环（DFS 检测）
  └── validateParallelPathOwnership()
      └── 无依赖关系的并行任务之间 allowedPaths 不能重叠
```

Lead 最多尝试 `maxPlanAttempts` 次（默认 2）。失败后，错误信息会附加到下一次 prompt 中。

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
  rolesJson: JSON.stringify(snapshotRoles(input.config))   // 固化角色快照
});
```

`writeTaskMarkdown` (`files.ts:47-104`) 生成人类可读的任务说明，包含任务元数据、目标、变更范围、验证命令、完成标准。

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

> **只修改 DB，不杀进程。** 如果 Runner 崩溃时 Agent 子进程还活着（`process.ts:16` 中 `detached: process.platform !== 'win32'`），这些进程会变成孤儿进程继续在旧 Worktree 中运行。restart 前应当先执行 `agent-team stop <runId>`。

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
    const promise = executeTask({ config, db, runId, record: candidate })
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

每个任务按严格顺序经历以下 7 个步骤。任一步骤失败触发 `retryOrFail`（第 233-252 行）：未超过 `maxWorkerAttempts`（默认 2）→ `changes_requested`；超过 → `failed`。

### 步骤 1：注入依赖 (`ensureTaskWorktree`)

`orchestrator.ts:254-285`

```
1. 如果 Worktree 已存在 (record.worktree && existsSync) → 复用
2. 否则创建:
   repoName = safeSegment(basename(repoRoot))
   path     = worktreesDir/repoName/runId/taskId
   branch   = branchPrefix/runId/taskId
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
// orchestrator.ts:145-156
const worker = await adapter.run<WorkerResult>({
  role: 'worker',
  cwd: worktreeInfo.path,
  prompt: workerPrompt({ task, startSha, runId, priorFeedback }),
  schema: WORKER_SCHEMA,
  logPath, outputPath,
  timeoutMs: config.taskTimeoutMs,
  staleAfterMs: config.staleAfterMs,
  onPid: (pid) => db.updateTask(runId, task.id, { pid }),
  onHeartbeat: () => { /* 每 3 秒更新 phase 为 'worker-active' */ }
});
```

Worker 的 prompt 模板在 `prompts.ts:33-51`：

```
loadSkill('worker')
+ 运行上下文 (runId, startSha)
+ 任务规格 (JSON.stringify(task))
+ 先前的失败或审查反馈 (priorFeedback，可选)
+ "Runner owns staging and commits. Do not run git add/commit/merge/rebase/push."
```

### 步骤 3：进程监控

`process.ts:6-52` 为 spawned Agent 进程设置双层守护：

| 守护层 | 触发条件 | 动作 |
|--------|---------|------|
| 硬超时 | `timeoutMs`（默认 2 小时）到期 | SIGTERM → 5 秒后 SIGKILL |
| 静默超时 | stdout/stderr 在 `staleAfterMs`（默认 10 分钟）内无数据 | SIGTERM → 5 秒后 SIGKILL |

`lastActivity` 在每次 stdout/stderr data 事件时更新。`terminateTree` (`process.ts:54-68`) 使用 `kill(-pid, SIGTERM)` 杀死整个进程组。

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
   changedFiles() (git status --porcelain=v1 -z)
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
     spawn(program, args)               ← 不经 shell，直接执行
     输出写入 verification log
     非零退出码 → 失败
```

命令安全检查 (`shell.ts`)：

- `splitCommand`: 手工解析命令字符串（处理引号、转义），**拒绝任何 shell 元字符**
- `assertAllowedCommand`: 逐 token 与 allowlist 前缀匹配
- `runCommand`: `spawn(program!, args)` — 不经过 shell

### 步骤 6：Reviewer 审查

```typescript
// orchestrator.ts:183
await stageAll(worktreeInfo.path);  // git add -A
```

Reviewer 的 prompt (`prompts.ts:54-71`)：

```
loadSkill('reviewer')
+ 任务规格 (JSON)
+ startSha
+ Worker 报告 (JSON)
+ "The candidate changes are staged. Inspect them with git diff --cached
   and read the affected files. Do not modify, stage, or commit anything."
```

Reviewer 以只读模式运行（Lead 同款 `--permission-mode dontAsk` + 只读工具）。

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
  if (reviewCycle >= maxReviewCycles) → failed
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
// orchestrator.ts:309-313
const worktree = join(config.worktreesDir, repoName, safeSegment(runId), 'integration');
const branch = `${config.branchPrefix}/${safeSegment(runId)}/integration`;
await createWorktree({ repoRoot, path: worktree, branch, baseSha: run.baseSha });
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

  const conflictResult = await adapter.run<IntegrationResult>({
    role: 'integrator',
    prompt: integrationPrompt({ mode: 'resolve_conflict', conflictFiles: conflicts }),
    ...
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
// orchestrator.ts:357-375
if (config.integration.runAgentAfterCherryPick) {
  const integrationRun = await adapter.run<IntegrationResult>({
    role: 'integrator',
    prompt: integrationPrompt({ mode: 'finalize', integrationAllowedPaths }),
    ...
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

## Agent Profile 与角色解析

### Profile 格式

`<cli>.<model>` 字符串，按**第一个** `.` 切分（`profiles.ts:parseProfile`）：

```
codex.gpt-5.6-terra          → cli=codex, model=gpt-5.6-terra
opencode.deepseek/v4-flash   → cli=opencode, model=deepseek/v4-flash
opencode.glm52               → 查 models.glm52 别名 → z-ai/glm-5.2
```

- model 段先查 `config.models` 别名表，未命中按字面量传给 CLI 的 `--model`。
- cli 段必须是 `claude | codex | opencode` 之一，否则抛错。

### 角色解析回退链（`profiles.ts:resolveRole`）

```
config.roles.<role> 存在 → parseProfile 解析
否则                     → defaultAdapter + adapters[defaultAdapter].model（与旧配置兼容）
```

### plan 快照（`profiles.ts:snapshotRoles` / `resolveRoleWithSnapshot`）

- `planRun` 成功后把全量四角色解析结果写入 `runs.roles_json`（`planner.ts:88-92`）。
- `run` 阶段 `resolveRoleWithSnapshot` 优先读快照，配置文件后续变化不影响已规划的 run。
- `agent-team run <id> -c roles.worker=...` 是人为强制修改：只更新被覆写的角色，其余保留快照（`cli.ts` run 分支）。

### 优先级总览

```
Worker CLI 选择:  task.adapter（Lead manifest） > worker 角色 profile > defaultAdapter
Lead/Reviewer/Integrator: 角色 profile > defaultAdapter
model 传递:       角色 profile 的 model > adapters.<cli>.model
配置值优先级:     -c 命令行 > config.yml > config.yaml > config.json > 内置默认
```

### 配置加载（`config.ts`）

- 文件优先级：`.agent-team/config.yml` > `config.yaml` > `config.json`（首个存在者）。
- YAML 用 `yaml` npm 包解析；JSON 走 `JSON.parse`。
- `applyOverrides(config, entries)` 处理 `-c path=value`：按 `.` 逐层写入，值先尝试 `JSON.parse`（数字/布尔/JSON 结构），失败按字符串。
- `initConfig` 生成带注释的 `config.yml` 模板（含 roles/models 示例）。

### 预检（`preflight.ts:checkProfileAvailability`）

`plan`/`launch`/`run` 启动前执行，`doctor` 展示结果：

| 检查项 | 结果 |
|--------|------|
| profile 语法 / cli 名称（`validateProfiles`） | error，阻止启动 |
| CLI 可用性（`<command> --version`，10s 超时） | error，阻止启动 |
| opencode model 在 `opencode models` 列表中（30s 超时） | error，阻止启动 |
| codex `provider/model`：provider 未在 `[model_providers.<id>]` 声明（config 缺失时同理） | error，阻止启动 |
| codex provider 的 `env_key` 环境变量缺失 | error，阻止启动 |
| codex 裸 model 名：与顶层/profile model 一致，或默认 provider 下的 OpenAI 命名（gpt、o、codex 前缀） | ok |
| codex 其余裸 model 名（无清单可枚举） | warning |
| claude model：与 settings 的 `model`/`env.ANTHROPIC_MODEL` 一致，或 `claude-*` 默认族命名 | ok |
| claude 配置了 `ANTHROPIC_BASE_URL` 网关时的其他 model | warning |
| claude 既非默认族命名、无网关、也未声明 | error，阻止启动 |

codex 校验由 `codex-config.ts` 实现：解析 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）的 section 头和 `key = "string"` 赋值子集（其余 TOML 语法安全跳过），提取 `model_providers.*`（含 env_key）、顶层 `model`/`model_provider`、`profiles.*.model`，`validateCodexModel` 为纯函数（env 可注入，便于测试）。

claude 校验由 `claude-config.ts` 实现：读取 `$CLAUDE_CONFIG_DIR/settings.json`（默认 `~/.claude/settings.json`）的顶层 `model` 和 `env.ANTHROPIC_MODEL`/`env.ANTHROPIC_BASE_URL`（settings 缺失或解析失败按 null 处理，环境变量兜底），`validateClaudeModel` 同为纯函数。

`run` 命令的预检基于 runs 表快照 + manifest 中出现的 task.adapter，而非当前配置文件。

## Adapter 层详解

### 接口定义

`adapters/types.ts`：

```typescript
export interface AgentAdapter {
  run<T>(input: AgentInvocation): Promise<AgentRunResult<T>>;
}
```

输入 (`types.ts:151-162`)：

```typescript
interface AgentInvocation {
  role: AgentRole;          // 'lead' | 'worker' | 'reviewer' | 'integrator'
  cwd: string;              // 工作目录
  prompt: string;           // 完整 prompt
  schema: object;           // JSON Schema
  logPath: string;          // 日志文件路径
  outputPath: string;       // 输出文件路径
  timeoutMs: number;        // 硬超时
  staleAfterMs: number;     // 静默超时
  onPid?: (pid: number) => void;
  onHeartbeat?: () => void;
}
```

输出 (`types.ts:164-170`)：

```typescript
interface AgentRunResult<T> {
  exitCode: number;
  output: T | null;         // 解析后的结构化结果
  rawOutput: string;        // stdout 原始文本
  timedOut: boolean;
  stalled: boolean;
}
```

### 工厂函数

`adapters/index.ts`：

```typescript
export function createAdapter(name: AdapterName, config: RunnerConfig, modelOverride?: string): AgentAdapter {
  const base = config.adapters[name];
  const adapterConfig = modelOverride ? { ...base, model: modelOverride } : base;
  if (name === 'claude') return new ClaudeAdapter(adapterConfig, config.verification.allowedCommandPrefixes);
  if (name === 'codex') return new CodexAdapter(adapterConfig);
  return new OpenCodeAdapter(adapterConfig);
}
```

- `modelOverride` 来自角色 profile 解析结果，存在时覆盖该 CLI 基础配置中的 model
- Claude adapter 额外接收 `allowedCommandPrefixes`，因为 Claude Code 的 `--allowedTools` 支持精细化的 Bash 命令前缀预批准
- Codex 和 OpenCode 用更粗粒度的 sandbox 控制

### 三处调用点的角色解析

| 调用点 | 角色 | 解析方式 |
|--------|------|---------|
| `planner.ts:44-45` | lead | `resolveRole('lead', config)` |
| `orchestrator.ts` executeTask | worker | `task.adapter` 优先；否则 `resolveRoleWithSnapshot('worker', ...)` |
| `orchestrator.ts` executeTask | reviewer | `resolveRoleWithSnapshot('reviewer', ...)` — 独立实例，不复用 Worker 的 adapter |
| `orchestrator.ts` integrateRun | integrator | `resolveRoleWithSnapshot('integrator', ...)` |

### Claude Code Adapter

生成的命令：

```bash
claude [extraArgs...] \
  -p "<prompt>" \
  --output-format stream-json \
  --verbose \
  --json-schema '<schema>' \
  --permission-mode dontAsk|acceptEdits \
  --allowedTools "Read,Glob,Grep,Edit,Write,Bash(...),..."
  [--model <model>]
```

工具列表区分角色：

| 角色 | permission-mode | 工具 |
|------|-----------------|------|
| Lead / Reviewer | `dontAsk` | Read, Glob, Grep, Bash(git status \*), Bash(git diff \*), Bash(git log \*), Bash(git show \*), Bash(git rev-parse \*), Bash(git ls-files \*) |
| Worker / Integrator | `acceptEdits` | 上述 + Edit, Write + `Bash(<each allowedCommandPrefix> *)` |

输出解析：从 Claude 的 `structured_output` 字段提取 JSON（`claude.ts:30-33`）。

### Codex Adapter

生成的命令：

```bash
codex exec \
  --json \
  --sandbox read-only|workspace-write \
  --ask-for-approval never \
  --output-schema /path/to/schema.json \
  -o /path/to/output.json \
  [--model <model>] \
  "<prompt>"
```

| 角色 | sandbox |
|------|---------|
| Lead / Reviewer | `read-only` |
| Worker / Integrator | `workspace-write` |

Schema 先写入临时文件，再通过 `--output-schema` 传入。

### OpenCode Adapter

生成的命令：

```bash
opencode run \
  --dir <cwd> \
  --format json \
  --auto \
  --agent plan|build \
  [--model <model>] \
  "<prompt + schema embedded>"
```

| 角色 | --agent |
|------|---------|
| Lead / Reviewer | `plan` |
| Worker / Integrator | `build` |

OpenCode CLI 不由 Runner 强制 JSON Schema；Schema 直接内嵌到 prompt 中，Runner 在返回后做本地结构校验。

### JSON 解析

`process.ts:70-105` `parseJsonLoose` — 对 Agent 原始输出做多层降级解析：

1. `JSON.parse(trimmed)` — 直接尝试
2. 提取 markdown code fence 中的 JSON（最后一个 ` ```json ` 块）
3. 从后往前逐行尝试 `JSON.parse`（适配 Claude stream-json 格式）
4. 在每行中递归搜索 `structured_output`/`output`/`result`/`text`/`content`/`message` 字段
5. 从最后一个 `{` 处截取并解析

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
; & | < > `         shell 控制/重定向操作符
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
planning → planned → running → needs_attention / integrating → done / failed / stopped
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
    → pid = null
    → lastError = 'Runner restarted while the task was active...'
    → 保留 worktree 和修改文件
```

`ensureTaskWorktree` 检测到已有 Worktree 时直接复用，避免重复创建。

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
  pid INTEGER,
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

## 后台运行 (`--detach`)

`cli.ts:112-127` — `--detach` 模式：

```typescript
const child = spawn(process.execPath, [
  cliPath, 'run', runId, '--foreground', '--repo', repoRoot
], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore'],
  env: process.env
});
child.unref();
```

- 父进程立即返回
- 子进程的 stdio 全部 `'ignore'` → **所有 `console.log` 输出被丢弃**
- Agent 日志仍然通过 `appendFileSync` 写入 `logs/` 目录
- 与前台运行的关键差异：最终状态面板不显示，错误不输出到 stderr，必须通过 `agent-team status` 检查结果
- 终止需要用 `agent-team stop`，Ctrl+C 无效
