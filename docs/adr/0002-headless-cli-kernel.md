# ADR 0002: 缩编为 headless CLI 执行内核

## 决策

agent-team 从全局常驻 daemon(ADR 0001)缩编为一次性 CLI 进程:
`agent-team run --contract <file>` 创建或重放一个 run,以结构化退出
(exit code + `pending.json` / `blockers.json` / `handoff`)与外层控制器协作。
删除 daemon、IPC、MCP gateway、controller lease、interaction broker、attach TUI
与 config.yml。项目注册与策略(含 allowlist 沉淀)仍存于全局
`$AGENT_TEAM_HOME/state.sqlite`;项目仓库内不写任何 runner 状态。

## 背景

ADR 0001 的集成面依赖 Host 平台能力: MCP logging 通知不进入模型上下文、
elicitation/sampling 无真实 Host 支持、thread resume 无稳定 transport。
"外层自动感知 run 事件"在该约束下不可实现,相关层的维护成本高于价值。
同时,多后端并行编排已被独立工具覆盖;本项目保持差异化的是跨厂商强制验收
(Runner 复跑验证、只读 Reviewer、Runner 提交)。

## 后果

- run 的生命周期等于 CLI 进程生命周期;跨崩溃/断线靠盘上状态与同 runId 重放
  (`resetInterrupted` + 后端 session resume),不依赖任何常驻进程。
- 唯一交互原语是结构化退出;审批默认 deny-and-collect,eager 防抖退出
  (默认 10s,可配),批准的命令沉淀进项目 allowlist。
- `blocked_on_contract` 只能由外层以修订契约重入恢复,规则与 0001 时代一致
  (approved 不可变、仅 blocked∪下游可改)。
- 与常驻终端运行时(如 Herdr)零耦合: 外层可把 run 进程放进受管 pane 获得
  断线存活,agent-team 不感知其存在。
- ADR 0001 中的 daemon/IPC/lease/MCP 决策随之作废。
