import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatedProtocolVersion } from '../src/agent/codex/generated.ts';

const sourceVersion = new URL('../src/agent/codex/protocol/GENERATED_FROM', import.meta.url);

test('generatedProtocolVersion returns the version recorded in GENERATED_FROM', () => {
  const expected = readFileSync(sourceVersion, 'utf8').trim();
  assert.notEqual(expected, '');
  assert.equal(generatedProtocolVersion(), expected);
});

test('generatedProtocolVersion returns undefined for empty, missing, or unreadable version files', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-generated-version-'));
  try {
    const path = join(root, 'GENERATED_FROM');
    assert.equal(generatedProtocolVersion(path), undefined);
    writeFileSync(path, ' \n\t ');
    assert.equal(generatedProtocolVersion(path), undefined);
    rmSync(path);
    mkdirSync(path);
    assert.equal(generatedProtocolVersion(path), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
