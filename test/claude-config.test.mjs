import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClaudeModel } from '../dist/core/claude-config.js';

test('accepts models declared in settings.json', () => {
  const settings = { model: 'glm-5.2', env: {} };
  assert.equal(validateClaudeModel('glm-5.2', settings, {}).level, 'ok');
});

test('accepts models declared via env', () => {
  assert.equal(validateClaudeModel('glm-5.2', null, { ANTHROPIC_MODEL: 'glm-5.2' }).level, 'ok');
  assert.equal(validateClaudeModel('glm-5.2', { env: { ANTHROPIC_MODEL: 'glm-5.2' } }, {}).level, 'ok');
});

test('accepts claude default-family naming without any config', () => {
  assert.equal(validateClaudeModel('claude-sonnet-5', null, {}).level, 'ok');
  assert.equal(validateClaudeModel('claude-opus-4.8', { env: {} }, {}).level, 'ok');
});

test('warns behind ANTHROPIC_BASE_URL gateway', () => {
  const verdict = validateClaudeModel('glm-5.2', { env: { ANTHROPIC_BASE_URL: 'https://proxy/v1' } }, {});
  assert.equal(verdict.level, 'warning');
  assert.match(verdict.message, /ANTHROPIC_BASE_URL/);
  assert.equal(validateClaudeModel('glm-5.2', null, { ANTHROPIC_BASE_URL: 'https://proxy/v1' }).level, 'warning');
});

test('errors on custom model without gateway or declaration', () => {
  const verdict = validateClaudeModel('glm-5.2', null, {});
  assert.equal(verdict.level, 'error');
  assert.match(verdict.message, /ANTHROPIC_BASE_URL/);
});
