import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProbeCache } from '../src/core/probe-cache.ts';

test('probe cache round-trips, expires by TTL, and isolates by version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-probe-'));
  const path = join(dir, 'cache.json');
  const cache = new ProbeCache(path, 60_000);
  cache.set('codex', 'gpt-5.6-terra', '0.148.0', { ok: true, latencyMs: 1200, checkedAt: Date.now() });
  cache.set('codex', 'gpt-5.6-terra', '0.149.0', { ok: false, error: 'nope', latencyMs: 100, checkedAt: Date.now() });

  assert.equal(cache.get('codex', 'gpt-5.6-terra', '0.148.0')?.ok, true);
  assert.equal(cache.get('codex', 'gpt-5.6-terra', '0.149.0')?.ok, false);
  assert.equal(cache.get('codex', 'gpt-5.6-terra', 'unknown'), null);
  assert.equal(cache.get('claude', 'gpt-5.6-terra', '0.148.0'), null);

  // 磁盘回路
  const reloaded = new ProbeCache(path, 60_000);
  assert.equal(reloaded.get('codex', 'gpt-5.6-terra', '0.148.0')?.ok, true);
  assert.ok(readFileSync(path, 'utf8').includes('gpt-5.6-terra'));

  // TTL 过期 → null（写入显式过期的 checkedAt，避免毫秒竞态）
  const expired = new ProbeCache(path, 60_000);
  expired.set('codex', 'gpt-5.6-terra', '0.148.0', { ok: true, latencyMs: 1, checkedAt: Date.now() - 120_000 });
  assert.equal(expired.get('codex', 'gpt-5.6-terra', '0.148.0'), null);
});

test('probe cache tolerates corrupt files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-probe-'));
  const path = join(dir, 'cache.json');
  writeFileSync(path, 'not json', 'utf8');
  const cache = new ProbeCache(path);
  assert.equal(cache.get('any', 'any', 'any'), null);
  cache.set('any', 'any', 'any', { ok: true, latencyMs: 1, checkedAt: Date.now() });
  assert.equal(new ProbeCache(path).get('any', 'any', 'any')?.ok, true);
});
