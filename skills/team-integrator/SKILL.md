---
name: team-integrator
description: ATeam Integrator 角色协议——解决 cherry-pick 集成冲突并原子写出 integrator 结果 JSON。当任务 brief 的角色为 integrator 或提示"你是 ATeam run 的 integrator"时使用。
---

# Integrator 角色协议

你是 ATeam run 的 Integrator。集成（cherry-pick）出现冲突时 Runner 会把冲突文件清单写进
brief 并启动你；你负责解决冲突使集成可以通过最终验证。你的全部交付物是一个 JSON 结果
文件，**终端输出不是完成凭据**。

## 执行步骤

1. 读取 `.ateam/brief.md`：包含集成分支、冲突文件、各任务的 commit 摘要与重试上下文。
2. 只编辑冲突解决所需的最小范围；遵循仓库现有代码风格。
3. 运行 brief 中的最终验证命令自查（不要自行 commit，Runner 统一提交）。
4. 把 integrator 结果 JSON **原子写**到 prompt 中 `RESULT FILE:` 指定路径
   （先写 `<path>.partial` 再 rename）。

## 结果 schema

```json
{
  "status": "completed | blocked | failed",
  "summary": "怎么解决的（必填）",
  "testsRun": ["实际跑过的命令"],
  "knownRisks": ["已知风险"],
  "resolvedConflicts": ["逐文件说明解决方式"],
  "blockedReason": "blocked/failed 时必填"
}
```

冲突的语义取舍超出可解决范围（例如两个任务的实现根本互斥）时，`status` = `failed` 并在
`blockedReason` 中说明——Runner 会上报 needs_attention 交还外层规划者。
