import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseFrames } from '../src/agent/codex/jsonrpc.ts';

test('parseFrames splits newline-delimited JSON across chunk boundaries', () => {
  const first = parseFrames('{"method":"a","id":1,"para');
  assert.deepEqual(first.messages, []);
  const second = parseFrames(first.rest + 'ms":null}\n{"id":1,"result":{"ok":true}}\nnot-json\n');
  assert.equal(second.messages.length, 2);
  assert.deepEqual(second.messages[1], { id: 1, result: { ok: true } });
  assert.equal(second.rest, '');
  // 未完成尾部保留
  const third = parseFrames('{"partial":');
  assert.deepEqual(third.messages, []);
  assert.equal(third.rest, '{"partial":');
});

test('parseFrames ignores empty lines and tolerates noise', () => {
  const { messages } = parseFrames('\n\n{"method":"n","params":{}}\n\n');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { method: 'n', params: {} });
});
