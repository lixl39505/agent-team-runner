import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseAgentJson } from '../src/agent/parse.ts';

test('parseAgentJson parses trimmed JSON directly', () => {
  assert.deepEqual(parseAgentJson(' \n {"status":"completed"} \n '), { status: 'completed' });
  assert.equal(parseAgentJson('null'), null);
});

test('parseAgentJson parses the final JSON code fence after direct parsing fails', () => {
  assert.deepEqual(parseAgentJson('Explanation\n```json\n{"first": true}\n```\n```\n{"last": true}\n```'), { last: true });
  assert.deepEqual(parseAgentJson('```json\n{"value": 1}\n```'), { value: 1 });
});

test('parseAgentJson falls back to the final object and rejects unparseable messages', () => {
  assert.deepEqual(parseAgentJson('Some explanation before {"status":"completed"}'), { status: 'completed' });
  assert.throws(() => parseAgentJson('not JSON\n```json\nnot JSON\n```'), /agent final message is not parseable JSON/);
  assert.throws(() => parseAgentJson('plain text'), /agent final message is not parseable JSON/);
});
