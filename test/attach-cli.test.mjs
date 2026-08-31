import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import { runAttachCli } from '../src/attach-cli.ts';

const home = {
  root: '/tmp/agent-team',
  stateDb: '/tmp/agent-team/state.sqlite',
  daemonLock: '/tmp/agent-team/daemon.lock',
  daemonInfo: '/tmp/agent-team/daemon.json',
  socket: '/tmp/agent-team/daemon.sock',
  runsDir: '/tmp/agent-team/runs',
  worktreesDir: '/tmp/agent-team/worktrees',
  preflightDir: '/tmp/agent-team/preflight'
};

function output(tty = false) {
  const stream = new PassThrough();
  if (tty) {
    stream.isTTY = true;
    stream.columns = 120;
    stream.rows = 20;
  }
  return stream;
}

function clientFor(interactions = []) {
  const calls = [];
  const client = {
    connect: async () => calls.push(['connect']),
    close: () => calls.push(['close']),
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === 'execution.events') return { events: [], lastEventId: 0 };
      if (method === 'execution.get') return { run: { status: 'running' }, tasks: [], agentExecutions: [] };
      if (method === 'interaction.list') return interactions;
      if (method === 'interaction.claim') return { status: 'claimed' };
      return {};
    }
  };
  return { client, calls };
}

test('attach parses --home, uses hostname and UUID, renders before advancing its event cursor, and detaches', async () => {
  const calls = [];
  const signals = new Map();
  const stream = output(true);
  const client = {
    connect: async () => calls.push(['connect']),
    close: () => calls.push(['close']),
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === 'execution.events') {
        return calls.filter(([name]) => name === 'execution.events').length === 1
          ? { events: [{ id: 7, eventType: 'AGENT_EVENT', payload: { execution: { agentId: 'worker-1' }, event: { type: 'message', text: 'working' } } }], lastEventId: 7 }
          : { events: [], lastEventId: 7 };
      }
      if (method === 'execution.get') return { run: { status: 'running' }, tasks: [], agentExecutions: [] };
      if (method === 'interaction.list') return [];
      return {};
    }
  };
  let resolved;
  await runAttachCli(['run-1', '--home', '/custom/home'], {
    resolveHome: (options) => {
      resolved = options;
      return home;
    },
    createClient: () => client,
    output: stream,
    hostname: () => 'test-host',
    randomUUID: () => 'client-1',
    registerSignal: (signal, listener) => signals.set(signal, listener),
    sleep: async () => {
      if (calls.filter(([name]) => name === 'execution.events').length === 2) signals.get('SIGINT')();
    }
  });
  assert.equal(resolved.env.AGENT_TEAM_HOME, '/custom/home');
  assert.deepEqual(calls[1], ['controller.attach', { runId: 'run-1', host: 'test-host', externalThreadId: 'run-1', clientId: 'client-1' }]);
  const events = calls.filter(([name]) => name === 'execution.events');
  assert.deepEqual(events.map(([, params]) => params), [
    { runId: 'run-1', clientId: 'client-1' },
    { runId: 'run-1', clientId: 'client-1', afterEventId: 7 }
  ]);
  assert.equal(calls.some(([name]) => name === 'interaction.requeue_client'), true);
  assert.equal(calls.some(([name]) => name === 'controller.disconnect'), true);
  assert.equal(calls.at(-1)[0], 'close');
});

test('attach answers approval, agent question, and contract block interactions', async () => {
  const cases = [
    [{ id: 'approval', status: 'queued', kind: 'approval', request: { tool: 'Bash', allowSession: true } }, ['s'], 'session'],
    [{ id: 'question', status: 'queued', kind: 'agent_question', request: { questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'one' }, { label: 'two' }], multiple: true, allowCustom: true }] } }, ['1, custom'], { choice: ['one', 'custom'] }],
    [{ id: 'block', status: 'queued', kind: 'contract_block', request: { reason: 'Need contract' } }, [''], { acknowledged: true }]
  ];
  for (const [interaction, answers, expected] of cases) {
    const { client, calls } = clientFor([interaction]);
    await runAttachCli(['run-1'], {
      resolveHome: () => home,
      createClient: () => client,
      output: output(true),
      randomUUID: () => 'client-1',
      ask: async () => answers.shift(),
      registerSignal: (_signal, listener) => { client.stop = listener; },
      sleep: async () => client.stop()
    });
    const answer = calls.find(([name]) => name === 'interaction.answer');
    assert.deepEqual(answer[1].response, expected);
  }
});

test('attach rejects session approval when it is not allowed and refreshes after a claim race', async () => {
  const interaction = { id: 'approval', status: 'queued', kind: 'approval', request: { allowSession: false } };
  const { client, calls } = clientFor([interaction]);
  client.request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'execution.events') return { events: [], lastEventId: 0 };
    if (method === 'execution.get') return { run: { status: 'running' }, tasks: [], agentExecutions: [] };
    if (method === 'interaction.list') return [interaction];
    if (method === 'interaction.claim') throw new Error('already claimed');
    return {};
  };
  await runAttachCli(['run-1'], {
    resolveHome: () => home,
    createClient: () => client,
    output: output(true),
    randomUUID: () => 'client-1',
    ask: async () => 's',
    registerSignal: (_signal, listener) => { client.stop = listener; },
    sleep: async () => client.stop()
  });
  assert.equal(calls.some(([name]) => name === 'interaction.answer'), false);
  assert.equal(calls.some(([name]) => name === 'interaction.requeue_client'), true);
});

test('attach validates arguments and safely cleans up after EOF', async () => {
  await assert.rejects(runAttachCli([], { resolveHome: () => home }), /Usage: agent-team attach/);
  await assert.rejects(runAttachCli(['run-1', '--bad'], { resolveHome: () => home }), /Unknown attach option/);
  await assert.rejects(runAttachCli(['run-1', '--home'], { resolveHome: () => home }), /--home requires a value/);
  const { client, calls } = clientFor();
  const input = new PassThrough();
  input.end();
  await runAttachCli(['run-1'], {
    resolveHome: () => home,
    createClient: () => client,
    input,
    output: output(),
    randomUUID: () => 'client-1'
  });
  assert.equal(calls.some(([name]) => name === 'controller.disconnect'), true);
});
