# ATeam Herdr 插件

把 ATeam 交付控制平面接入 Herdr 的最小插件：两个固定 action（启动/认领蜂群 run、恢复协调）
和一个 startup hook（无副作用 reconcile 检查）。

> 安装插件等同在本机运行可执行代码。安装前请审查 `herdr-plugin.toml` 与其指向的
> `src/cli.ts`（ADR 运行时约束：安装与升级视为本地可执行代码变更，需要审查）。

## 安装

```sh
# 本地开发（仓库根目录的父级视角）：
herdr plugin link <repo>/plugin

# 确认
herdr plugin list
herdr plugin action list --plugin ateam
```

插件 command 以 `bun run src/cli.ts ...` 相对插件根目录执行——`plugin link` 指向本仓库
的 `plugin/` 目录时，`src/cli.ts` 解析为仓库源码。发布安装（GitHub）前请先构建或改为指向
编译产物。

## 入口

| 入口 | 行为 |
|---|---|
| action `run-team-swarm` | 在当前 workspace 启动/认领 Runner（`agent-team run --claim`）。本 pane 即 Runner pane，Runner 会向它自报 working/blocked/done/idle |
| action `reconcile-team-runs` | 对全部未终结 run 执行恢复协调（先订阅后快照、补做落盘结果、只为无法恢复的执行新建 attempt） |
| startup hook | `reconcile --dry-run`：只探测与汇报，不产生副作用 |

## 契约

- `min_herdr_version` 固定最低 Herdr 版本；升级 Herdr 后需回归 e2e。
- 基于 contract 动态创建的 Agent pane 全部由 Runner 通过 Herdr API 创建；插件不承载任何
  动态入口（plugin v1 的 action/pane 均为 manifest 静态声明）。
