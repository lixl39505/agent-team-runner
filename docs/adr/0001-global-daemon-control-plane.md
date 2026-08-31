# ADR 0001: 全局 daemon 控制面

## 决策

执行状态、项目策略、ExecutionContract、controller lease、interaction 和 handoff
均保存于 `$AGENT_TEAM_HOME` 的 SQLite 数据库与 run 目录。目标仓库只提供 Git
工作区和可选 implementation skill，不保存 runner 的运行状态或项目策略。

## 后果

- MCP client、attach TUI 和 daemon 可独立重启，并通过持久 cursor 与 lease 恢复。
- 外层 controller 必须注册项目、提交完整契约，并负责最终 Spec Review。
- `blocked_on_contract` 只能由完整契约 revision 恢复；已批准任务不可被 revision 修改。
- 完成的 run 会产生 `handoff.json` 和 `handoff.md`，供外层流程继续集成或审查。
