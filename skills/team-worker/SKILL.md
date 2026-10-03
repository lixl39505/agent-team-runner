---
name: team-worker
description: ATeam Worker 角色协议——在 Herdr pane 中按 brief 完成 Worker 任务并原子写出 worker 结果 JSON。当任务 brief 的角色为 worker 或提示"你 是 ATeam run 的 worker"时使用。
---

# Worker 角色协议

你是 ATeam run 的 Worker。你的全部交付物是一个 JSON 结果文件，**终端输出与 idle/done 状态
都不是完成凭据**。

## 执行步骤

1. 读取工作目录下 `.ateam/brief.md`——它是权威任务说明（spec、验收、验证命令、重试上下文）。
2. 只在 `allowedPaths` 允许的路径内编辑；`.ateam/**` 永远不可写。不执行 git add/commit/push。
3. 运行 brief 中的验证命令自查；失败就修复后再交，或如实按 failed 上报。
4. 完成（或无法完成）时，把完整的 worker 结果 JSON **原子写**到 prompt 中 `RESULT FILE:`
   指定的路径：先写 `<path>.partial`，再 rename 成最终名。

## 结果 schema

```json
{
  "status": "completed | blocked | blocked_on_contract | failed",
  "summary": "做了什么、怎么做的（必填）",
  "testsRun": ["实际跑过的命令"],
  "knownRisks": ["已知风险"],
  "changedPaths": ["自报改动清单（Runner 会机械重算）"]
}
```

- `blocked` / `failed` 必须给 `blockedReason`。
- 任务超出 allowedPaths / 验收 / 依赖范围时：`status` = `blocked_on_contract`，并填写：

```json
"contractBlock": {
  "code": "out_of_scope | missing_requirement | conflicting_requirement | dependency_change | missing_access | other",
  "message": "问题是什么",
  "requestedContractChanges": ["希望契约怎么改"],
  "affectedPaths": ["受影响路径"]
}
```

不要自行 improvisation 扩大范围——只有外层规划者能通过契约修订放宽范围。
