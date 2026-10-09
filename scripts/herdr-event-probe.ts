// herdr 事件协议探针（真机升级复检用；用法：bun scripts/herdr-event-probe.ts <pane_id>）。
// 协议结论的权威对照表见 docs/herdr-protocol.md；本脚本是其「升级复检清单」第 2 步。
//
// 前置：herdr server 运行中（`herdr server` 为 headless），且已有一个 workspace
// （`herdr workspace create --cwd <git 仓库> --label probe --no-focus`，取其
// root_pane.pane_id 作为参数；HERDR_PROBE_WORKSPACE=<workspace_id> 时会真实
// create/remove 一个 worktree 观察事件）。跑完 `herdr workspace close <id>` 清理。
//
// 校验点（herdr 0.9.1 / protocol 22 实测结论，见 docs/herdr-protocol.md）：
//   1. 订阅类型名用点号且被校验（白名单含 worktree.created/opened/removed）；
//      非法类型报 invalid_request 且错误信封 id 为 ""（传输层须快速拒绝）。
//   2. 每条连接只有第一个 events.subscribe 生效，后续静默丢弃。
//   3. 事件 wire：载荷在 data 里；类型名混用 —— event 字段可能点号
//      (pane.agent_status_changed) 或下划线 (pane_closed)，worktree 事件
//      data.type 为下划线；workspace_id 多在 data 顶层，worktree.created 嵌在
//      data.workspace.workspace_id；worktree 事件无 pane_id（按 repo 上下文
//      投递到已有 pane 订阅）。
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sockPath = process.env.HERDR_SOCKET_PATH ?? join(homedir(), '.config', 'herdr', 'herdr.sock');
const PANE = process.argv[2] ?? '';
if (!PANE) {
  console.error('usage: bun scripts/herdr-event-probe.ts <pane_id>');
  process.exit(1);
}

const socket: Socket = connect(sockPath);
await new Promise<void>((res, rej) => {
  socket.once('connect', () => res());
  socket.once('error', rej);
});
const lines: string[] = [];
let buf = '';
socket.on('data', (c: Buffer) => {
  buf += c.toString('utf8');
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (l.trim()) { lines.push(l); console.log('<<', l.slice(0, 800)); }
  }
});
let seq = 0;
const request = (method: string, params: unknown): string => {
  const id = `probe-${++seq}`;
  socket.write(`${JSON.stringify({ id, method, params })}\n`);
  return id;
};
const waitAck = async (id: string, ms = 5000): Promise<void> => {
  const dl = Date.now() + ms;
  while (Date.now() < dl && !lines.some((l) => l.includes(`"id":"${id}"`) || l.includes('"id":""'))) await Bun.sleep(20);
};

// 1) 混合订阅（生产传输层的形状）——必须 ack
const subId = request('events.subscribe', { subscriptions: [
  'pane.agent_status_changed', 'pane.closed', 'pane.exited', 'worktree.created', 'worktree.removed',
].map((t) => ({ type: t, pane_id: PANE })) });
await waitAck(subId);

// 2) 伪造类型（独立连接）——应看到 id:"" 的 invalid_request
const raw2: Socket = connect(sockPath);
await new Promise<void>((res, rej) => { raw2.once('connect', () => res()); raw2.once('error', rej); });
let b2 = '';
raw2.on('data', (c: Buffer) => { b2 += c.toString(); console.log('[bogus-conn] <<', b2.split('\n')[0]?.slice(0, 300)); });
raw2.write(`${JSON.stringify({ id: 'b1', method: 'events.subscribe', params: { subscriptions: [{ type: 'bogus.type', pane_id: PANE }] } })}\n`);
await Bun.sleep(1500);
raw2.destroy();

// 3) 同连接第二次订阅 —— 预期无响应（静默丢弃）
const dupId = request('events.subscribe', { subscriptions: [{ type: 'pane.closed', pane_id: PANE }] });
await waitAck(dupId, 2000);

// 4) 真实 create/remove，观察事件 wire 行
const cli = (args: string[]) => Bun.spawnSync(['herdr', ...args], { stdout: 'pipe', stderr: 'pipe' });
const wsArg = process.env.HERDR_PROBE_WORKSPACE;
if (wsArg) {
  const create = cli(['worktree', 'create', '--workspace', wsArg, '--branch', 'probe/events']);
  const ws = (JSON.parse(new TextDecoder().decode(create.stdout)) as { result?: { workspace?: { workspace_id?: string } } }).result?.workspace?.workspace_id;
  console.log(`created: ${ws}`);
  await Bun.sleep(1500);
  if (ws) cli(['worktree', 'remove', '--workspace', ws, '--force']);
  await Bun.sleep(1500);
} else {
  console.log('(skip live create/remove: set HERDR_PROBE_WORKSPACE=<workspace_id> to exercise worktree events)');
}

await Bun.sleep(500);
socket.destroy();
console.log(`done; ${lines.length} line(s) on the subscription connection`);
