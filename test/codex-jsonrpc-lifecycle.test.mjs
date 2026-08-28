import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcConnection } from '../src/agent/codex/jsonrpc.ts';

const serverProgram = String.raw`
let buffer = '';
let pendingRequestId;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'succeed') {
      const frame = JSON.stringify({ id: message.id, result: { echoed: message.params } }) + '\n';
      process.stdout.write(frame.slice(0, 8));
      process.stdout.write(frame.slice(8));
    } else if (message.method === 'reject') {
      send({ id: message.id, error: { message: 'server rejected request' } });
    } else if (message.method === 'reject-empty') {
      send({ id: message.id, error: {} });
    } else if (message.method === 'notify') {
      send({ method: 'observed', params: message.params });
    } else if (message.method === 'server-success' || message.method === 'server-failure' || message.method === 'server-non-error' || message.method === 'server-default') {
      pendingRequestId = message.id;
      const id = message.method;
      send({ method: 'approval', id, params: { action: message.method } });
    } else if (message.method === 'noise') {
      process.stdout.write('not-json\n\nnull\n[]\n');
      send({ id: 'unknown', result: 'ignored' });
      send({ id: message.id, result: 'clean' });
    } else if (message.method === 'exit') {
      process.exit(0);
    } else if (message.id === 'server-success' || message.id === 'server-failure' || message.id === 'server-non-error' || message.id === 'server-default') {
      const response = Object.hasOwn(message, 'result') ? message.result : message.error;
      send({ id: pendingRequestId, result: response });
    }
  }
});
`;

function createConnection(handlers = {}) {
  return new JsonRpcConnection(process.execPath, ['-e', serverProgram], handlers);
}

test('JsonRpcConnection exchanges requests, notifications, and server requests', async () => {
  let notify;
  let exited;
  const notifications = [];
  const connection = createConnection({
    onNotification(method, params) {
      notifications.push({ method, params });
      notify?.();
    },
    async onServerRequest(method, params) {
      assert.equal(method, 'approval');
      if (params.action === 'server-failure') throw new Error('approval denied');
      if (params.action === 'server-non-error') throw 'approval denied as text';
      return { approved: true };
    },
    onExit(error) {
      exited?.(error);
    }
  });

  assert.equal(connection.exited, false);
  assert.equal(typeof connection.pid, 'number');
  assert.deepEqual(await connection.request('succeed', { value: 1 }, 500), { echoed: { value: 1 } });

  const notified = new Promise((resolve) => { notify = resolve; });
  connection.notify('notify', { received: true });
  await notified;
  assert.deepEqual(notifications, [{ method: 'observed', params: { received: true } }]);

  assert.deepEqual(await connection.request('server-success', null, 500), { approved: true });
  assert.deepEqual(await connection.request('server-failure', null, 500), { message: 'approval denied' });
  assert.deepEqual(await connection.request('server-non-error', null, 500), { message: 'approval denied as text' });
  assert.equal(await connection.request('noise', null, 500), 'clean');
  await assert.rejects(connection.request('reject', null, 500), /server rejected request/);
  await assert.rejects(connection.request('reject-empty', null, 500), /app-server request failed/);

  const exit = new Promise((resolve) => { exited = resolve; });
  await assert.rejects(connection.request('exit', null, 500), /app-server process exited/);
  assert.match((await exit).message, /app-server process exited/);
  assert.equal(connection.exited, true);
  await assert.rejects(connection.request('after-exit', null), /connection is closed/);
});

test('JsonRpcConnection times out and close rejects pending requests', async () => {
  const connection = createConnection();

  assert.equal(await connection.request('server-default', null, 500), null);
  await assert.rejects(connection.request('never', null, 20), /"never" timed out after 20ms/);

  const pending = connection.request('never', null, 500);
  connection.close();
  connection.child.stderr.emit('data', 'ignored after close');
  await assert.rejects(pending, /connection closed/);
  assert.equal(connection.exited, true);
  assert.doesNotThrow(() => connection.notify('ignored-after-close', null));
  await assert.rejects(connection.request('after-close', null), /connection is closed/);
  connection.close();
});

test('JsonRpcConnection reports child process startup errors', async () => {
  const errors = [];
  const command = join(tmpdir(), `agent-team-missing-command-${process.pid}-${Date.now()}`);
  const connection = new JsonRpcConnection(command, [], { onExit: (error) => errors.push(error) });

  await assert.rejects(connection.request('unreachable', null, 500), /app-server process error/);
  assert.equal(connection.exited, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /app-server process error/);
});

test('JsonRpcConnection supports omitted handlers, custom cwd, and stderr diagnostics', async () => {
  const diagnostics = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    diagnostics.push(String(chunk));
    return true;
  };

  try {
    const connection = new JsonRpcConnection(
      process.execPath,
      ['-e', "process.stderr.write('startup diagnostic\\n'); process.stdin.on('data', () => process.exit(0));"],
      undefined,
      { PATH: process.env.PATH ?? '' },
      tmpdir()
    );
    await assert.rejects(connection.request('exit', null, 500), /app-server process exited/);
    assert.match(diagnostics.join(''), /startup diagnostic/);
  } finally {
    process.stderr.write = write;
  }
});
