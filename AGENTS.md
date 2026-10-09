## Global Rules

- 临时脚本放 `temp/`, 不入 git;
- **后续有用的经验和结论不留在 `temp/`**——沉淀为 `docs/` 下的 md 文档（或注入 agent 的
  `skills/`），并把引用写进本文件。当前权威文档：
  - [docs/adr/0001-herdr-native-delivery-control-plane.md](docs/adr/0001-herdr-native-delivery-control-plane.md) — 设计权威；
  - [docs/herdr-protocol.md](docs/herdr-protocol.md) — Herdr 0.9.x 真机协议约束权威对照表（改集成代码/升级 herdr 前必读）；
  - [docs/e2e.md](docs/e2e.md) — 真机端到端验证清单；
  - `scripts/` — 可复用的真机探针/工具脚本（如 `herdr-event-probe.ts`），入 git。
