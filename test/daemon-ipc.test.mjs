import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalIpcClient, LocalIpcServer } from '../src/daemon/ipc.ts';

async function withSocket(run) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-team-ipc-'));
  const path = join(directory, 'daemon.sock');
  try {
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function connectRaw(path) {
  const socket = createConnection(path);
  socket.setEncoding('utf8');
  let buffer = '';
  const messages = [];
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      messages.push(JSON.parse(line));
      newline = buffer.indexOf('\n');
    }
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({ socket, messages }));
    socket.once('error', reject);
  });
}

async function waitForMessage(messages, index) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (messages[index]) return messages[index];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for IPC response');
}

test('LocalIpcServer and LocalIpcClient exchange requests and clean socket files', async () => {
  await withSocket(async (path) => {
    await writeFile(path, 'stale socket');
    const server = new LocalIpcServer();
    server.register('echo', async (params) => ({ params }));
    await server.start(path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(server.start(path), /already running/);

    const client = new LocalIpcClient(path);
    await client.connect();
    assert.deepEqual(await client.request('echo', { value: 1 }), { params: { value: 1 } });
    assert.deepEqual(await client.request('echo'), {});
    await assert.rejects(client.request('missing'), /Unknown IPC method: missing/);
    client.close();
    client.close();
    await assert.rejects(client.request('echo'), /connection is closed/);

    await server.stop();
    await assert.rejects(access(path));
    await server.stop();
  });
});

test('LocalIpcServer returns protocol and handler errors without dropping its connection', async () => {
  await withSocket(async (path) => {
    const server = new LocalIpcServer();
    server.register('throw-error', async () => { throw new Error('handler failed'); });
    server.register('throw-value', async () => { throw 'handler text'; });
    server.register('ok', async () => 'still running');
    await server.start(path);
    const { socket, messages } = await connectRaw(path);
    try {
      socket.write('\nnot json\nnull\n[]\n{"id":true,"method":"ok"}\n');
      socket.write('{"id":"unknown","method":"nope"}\n');
      socket.write('{"id":1,"method":"throw-error"}\n');
      socket.write('{"id":2,"method":"throw-value"}\n');
      socket.write('{"id":3,"method":"ok"}\n');

      assert.deepEqual(await waitForMessage(messages, 0), { id: null, error: { message: 'Invalid IPC JSON' } });
      assert.deepEqual(await waitForMessage(messages, 1), { id: null, error: { message: 'Invalid IPC request' } });
      assert.deepEqual(await waitForMessage(messages, 2), { id: null, error: { message: 'Invalid IPC request' } });
      assert.deepEqual(await waitForMessage(messages, 3), { id: null, error: { message: 'Invalid IPC request' } });
      assert.deepEqual(await waitForMessage(messages, 4), { id: 'unknown', error: { message: 'Unknown IPC method: nope' } });
      assert.deepEqual(await waitForMessage(messages, 5), { id: 1, error: { message: 'handler failed' } });
      assert.deepEqual(await waitForMessage(messages, 6), { id: 2, error: { message: 'handler text' } });
      assert.deepEqual(await waitForMessage(messages, 7), { id: 3, result: 'still running' });
    } finally {
      socket.destroy();
      await server.stop();
    }
  });
});

test('LocalIpcClient supports out-of-order responses, timeouts, and server disconnects', async () => {
  await withSocket(async (path) => {
    const server = new LocalIpcServer();
    server.register('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return 'slow';
    });
    server.register('fast', async () => 'fast');
    server.register('never', async () => new Promise(() => {}));
    await server.start(path);
    const client = new LocalIpcClient();
    await client.connect(path);
    await assert.rejects(client.connect(path), /already connected/);

    const [serverSocket] = server.sockets;
    serverSocket.write('\nnot json\nnull\n[]\n{"id":"wrong","result":"ignored"}\n{"id":999,"result":"ignored"}\n');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const order = [];
    const slow = client.request('slow').then((value) => { order.push(value); return value; });
    const fast = client.request('fast').then((value) => { order.push(value); return value; });
    assert.deepEqual(await Promise.all([slow, fast]), ['slow', 'fast']);
    assert.deepEqual(order, ['fast', 'slow']);
    await assert.rejects(client.request('never', undefined, 15), /timed out after 15ms/);

    const malformedResponse = assert.rejects(client.request('never'), /IPC request failed/);
    serverSocket.write('{"id":4,"error":{}}\n');
    await malformedResponse;

    const pending = assert.rejects(client.request('never'), /IPC connection closed/);
    await server.stop();
    await pending;
  });
});

test('LocalIpcServer handles listen and close failures and avoids writing to closed peers', async () => {
  await withSocket(async (path) => {
    const invalidPathServer = new LocalIpcServer();
    await assert.rejects(invalidPathServer.start(path.slice(0, -11) + 'x'.repeat(120)), /ENAMETOOLONG|EINVAL|invalid argument/i);
    await invalidPathServer.stop();

    const unlinkFailureServer = new LocalIpcServer();
    const directory = join(path, '..');
    await assert.rejects(unlinkFailureServer.start(directory), /EISDIR|EPERM|illegal operation/i);

    const server = new LocalIpcServer();
    let completed = false;
    server.register('late', async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      completed = true;
      return 'too late';
    });
    await server.start(path);
    const { socket } = await connectRaw(path);
    socket.write('{"id":1,"method":"late"}\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(completed, true);

    await new Promise((resolve) => server.server.close(resolve));
    await assert.rejects(server.stop(), /not running/);
  });
});

test('LocalIpcClient rejects unavailable paths and pending requests when closed', async () => {
  const missing = new LocalIpcClient();
  await assert.rejects(missing.connect(), /socket path is required/);

  await withSocket(async (path) => {
    const server = new LocalIpcServer();
    server.register('never', async () => new Promise(() => {}));
    await server.start(path);
    const client = new LocalIpcClient(path);
    await client.connect();
    const pending = assert.rejects(client.request('never'), /IPC connection closed/);
    client.close();
    await pending;
    await server.stop();
  });

  const unavailable = new LocalIpcClient(join(tmpdir(), `missing-ipc-${process.pid}-${Date.now()}.sock`));
  await assert.rejects(unavailable.connect(), /IPC connection error/);
});
