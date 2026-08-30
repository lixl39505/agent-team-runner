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

test('masked prompt rejects non-TTY input, supports backspace, and allows cancellation', async () => {
  await assert.rejects(promptMaskedSecret('API key: ', new PassThrough(), new PassThrough()), /interactive terminal/);

  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = true;
  const edited = promptMaskedSecret('API key: ', input, output);
  input.emit('data', Buffer.from('ab\x7fc\x01\n'));
  assert.equal(await edited, 'ac');

  const cancelledInput = new PassThrough();
  cancelledInput.isTTY = true;
  cancelledInput.setRawMode = () => {};
  const cancelled = promptMaskedSecret('API key: ', cancelledInput, output);
  cancelledInput.emit('data', Buffer.from('\u0003'));
  await assert.rejects(cancelled, /cancelled/);

  const noRaw = new PassThrough();
  noRaw.isTTY = true;
  await assert.rejects(promptMaskedSecret('API key: ', noRaw, output), /interactive terminal/);
  await assert.rejects(promptMaskedSecret(), /interactive terminal/);
});
