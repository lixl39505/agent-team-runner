import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import { attachArguments, runAttachCli } from '../src/attach-cli.ts';

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

function input() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => {};
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

test('attach answers approval, agent question, and contract block interactions after a keyboard a command', async () => {
  const cases = [
    [{ id: 'approval', status: 'queued', kind: 'approval', request: { tool: 'Bash', allowSession: true } }, ['s'], 'session'],
    [{ id: 'question', status: 'queued', kind: 'agent_question', request: { questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'one' }, { label: 'two' }], multiple: true, allowCustom: true }] } }, ['1, custom'], { choice: ['one', 'custom'] }],
    [{ id: 'block', status: 'queued', kind: 'contract_block', request: { reason: 'Need contract' } }, [''], { acknowledged: true }]
  ];
  for (const [interaction, answers, expected] of cases) {
    const { client, calls } = clientFor([interaction]);
    const keyboard = input();
    let sleeps = 0;
    await runAttachCli(['run-1'], {
      resolveHome: () => home,
      createClient: () => client,
      input: keyboard,
      output: output(true),
      randomUUID: () => 'client-1',
      ask: async () => answers.shift(),
      registerSignal: (_signal, listener) => { client.stop = listener; },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) keyboard.write('a');
        else client.stop();
      }
    });
    const answer = calls.find(([name]) => name === 'interaction.answer');
    assert.deepEqual(answer[1].response, expected);
  }
});

test('attach reads the selected agent log on l and renders durable events when the log is unavailable', async () => {
  for (const [logResult, expected] of [
    [{ runId: 'run-1', agentId: 'agent-1', content: 'tail line' }, /tail line/],
    [new Error('Agent log does not exist: run-1\/agent-1'), /EVENT FALLBACK[\s\S]*Agent log does not exist[\s\S]*durable event/i]
  ]) {
    const calls = [];
    const keyboard = input();
    const screen = output(true);
    let stop;
    let sleeps = 0;
    const client = {
      connect: async () => {},
      close: () => {},
      request: async (method, params) => {
        calls.push([method, params]);
        if (method === 'execution.events') {
          return { events: [{ eventType: 'AGENT_EVENT', payload: { execution: { agentId: 'agent-1' }, event: { type: 'message', text: 'durable event' } } }], lastEventId: 1 };
        }
        if (method === 'execution.get') {
          return { run: { status: 'running' }, tasks: [], agentExecutions: [{ agentId: 'agent-1', role: 'worker', backend: 'codex', status: 'running' }] };
        }
        if (method === 'interaction.list') return [];
        if (method === 'execution.agent_log') {
          if (logResult instanceof Error) throw logResult;
          return logResult;
        }
        return {};
      }
    };
    await runAttachCli(['run-1'], {
      resolveHome: () => home,
      createClient: () => client,
      input: keyboard,
      output: screen,
      randomUUID: () => 'client-1',
      registerSignal: (_signal, listener) => { stop = listener; },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) keyboard.write('l');
        else stop();
      }
    });
    assert.deepEqual(calls.find(([method]) => method === 'execution.agent_log'), [
      'execution.agent_log', { runId: 'run-1', agentId: 'agent-1' }
    ]);
    assert.match(screen.read()?.toString() ?? '', expected);
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
  const keyboard = input();
  let sleeps = 0;
  await runAttachCli(['run-1'], {
    resolveHome: () => home,
    createClient: () => client,
    input: keyboard,
    output: output(true),
    randomUUID: () => 'client-1',
    ask: async () => 's',
    registerSignal: (_signal, listener) => { client.stop = listener; },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) keyboard.write('a');
      else client.stop();
    }
  });
  assert.equal(calls.some(([name]) => name === 'interaction.answer'), false);
  assert.equal(calls.some(([name]) => name === 'interaction.requeue_client'), true);
});

test('attach maps Enter to Inbox answers, d to approval denial, and f to repeated log tails', async () => {
  const interaction = { id: 'approval', status: 'queued', kind: 'approval', request: { allowSession: true } };
  const { client, calls } = clientFor([interaction]);
  client.request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'execution.events') return { events: [], lastEventId: 0 };
    if (method === 'execution.get') {
      return { run: { status: 'running' }, tasks: [], agentExecutions: [{ agentId: 'agent-1', role: 'worker', backend: 'codex', status: 'running' }] };
    }
    if (method === 'interaction.list') return [interaction];
    if (method === 'interaction.claim') return {};
    if (method === 'execution.agent_log') return { agentId: 'agent-1', content: 'tail' };
    return {};
  };
  const keyboard = input();
  let sleeps = 0;
  await runAttachCli(['run-1'], {
    resolveHome: () => home,
    createClient: () => client,
    input: keyboard,
    output: output(true),
    randomUUID: () => 'client-1',
    ask: async () => 'o',
    registerSignal: (_signal, listener) => { client.stop = listener; },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) keyboard.write('\r');
      else if (sleeps === 2) keyboard.write('d');
      else if (sleeps === 3) keyboard.write('f');
      else if (sleeps === 5) client.stop();
    }
  });
  assert.equal(calls.filter(([name]) => name === 'interaction.answer').some(([, params]) => params.response === 'once'), true);
  assert.equal(calls.filter(([name]) => name === 'interaction.answer').some(([, params]) => params.response === 'deny'), true);
  assert.equal(calls.filter(([name]) => name === 'execution.agent_log').length >= 2, true);
});

test('attach accepts SGR mouse clicks for run and agent selection when the terminal advertises support', async () => {
  const previousTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  try {
    const calls = [];
    const keyboard = input();
    let stop;
    let sleeps = 0;
    const client = {
      connect: async () => {
        setImmediate(() => {
          keyboard.write('\x1b[<0;10;5M');
          keyboard.write('\r');
        });
      },
      close: () => {},
      request: async (method, params) => {
        calls.push([method, params]);
        if (method === 'project.list') return [{ id: 'project-1', displayName: 'Project One' }];
        if (method === 'execution.list') return [
          { id: 'run-1', projectId: 'project-1', status: 'running' },
          { id: 'run-2', projectId: 'project-1', status: 'running' }
        ];
        if (method === 'execution.events') return { events: [], lastEventId: 0 };
        if (method === 'execution.get') {
          return {
            run: { status: 'running' }, tasks: [],
            agentExecutions: [
              { agentId: 'agent-1', role: 'worker', backend: 'codex', status: 'running' },
              { agentId: 'agent-2', role: 'reviewer', backend: 'codex', status: 'running' }
            ]
          };
        }
        if (method === 'interaction.list') return [];
        if (method === 'execution.agent_log') return { agentId: params.agentId, content: 'tail' };
        return {};
      }
    };
    await runAttachCli([], {
      resolveHome: () => home,
      createClient: () => client,
      input: keyboard,
      output: output(true),
      randomUUID: () => 'client-1',
      registerSignal: (_signal, listener) => { stop = listener; },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) keyboard.write('\x1b[<0;100;5M');
        else if (sleeps === 2) keyboard.write('l');
        else stop();
      }
    });
    assert.deepEqual(calls.find(([name]) => name === 'controller.attach')?.[1].runId, 'run-2');
    assert.deepEqual(calls.find(([name]) => name === 'execution.agent_log')?.[1], { runId: 'run-2', agentId: 'agent-2' });
  } finally {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  }
});

test('attach parses optional run IDs and validates options', async () => {
  assert.deepEqual(attachArguments([], () => home), { home });
  assert.deepEqual(attachArguments(['run-1'], () => home), { runId: 'run-1', home });
  assert.throws(() => attachArguments(['run-1', '--bad'], () => home), /Unknown attach option/);
  assert.throws(() => attachArguments(['run-1', '--home'], () => home), /--home requires a value/);
});

test('attach prints project and run choices without a TTY and safely cleans up after EOF', async () => {
  const choices = clientFor();
  choices.client.request = async (method, params) => {
    choices.calls.push([method, params]);
    if (method === 'project.list') return [{ id: 'project-1', displayName: 'Project One' }];
    if (method === 'execution.list') return [{ id: 'run-1', projectId: 'project-1', status: 'running' }];
    return {};
  };
  const listed = output();
  await runAttachCli([], {
    resolveHome: () => home,
    createClient: () => choices.client,
    output: listed
  });
  assert.match(listed.read()?.toString() ?? '', /Project One/);
  assert.equal(choices.calls.some(([name]) => name === 'controller.attach'), false);
  assert.equal(choices.calls.at(-1)[0], 'close');

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
