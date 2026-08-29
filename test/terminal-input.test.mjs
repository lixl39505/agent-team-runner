import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import { promptMaskedSecret } from '../src/core/terminal-input.ts';

test('masked prompt returns input without echoing it', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const rawModes = [];
  input.setRawMode = (mode) => rawModes.push(mode);
  const output = new PassThrough();
  output.isTTY = true;
  let displayed = '';
  output.on('data', (chunk) => { displayed += chunk.toString(); });

  const answer = promptMaskedSecret('API key: ', input, output);
  input.emit('data', Buffer.from('not-displayed\r'));

  assert.equal(await answer, 'not-displayed');
  assert.equal(displayed, 'API key: \n');
  assert.deepEqual(rawModes, [true, false]);
});
