import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexConfig, validateCodexModel } from '../dist/core/codex-config.js';

const SAMPLE_TOML = `
# codex config
model = "gpt-5.6-terra"
model_provider = "deepseek"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://example.com/v1"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
requires_openai_auth = false

[model_providers.ollama]
name = "Ollama"
base_url = "http://localhost:11434/v1"

[profiles.fast]
model = "gpt-5-mini"
`;

const config = parseCodexConfig(SAMPLE_TOML);

test('parses model_providers, env keys, and top-level model', () => {
  assert.equal(config.defaultModel, 'gpt-5.6-terra');
  assert.equal(config.modelProvider, 'deepseek');
  assert.deepEqual(config.providers.deepseek, {
    envKey: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://example.com/v1'
  });
  assert.deepEqual(config.providers.ollama, { baseUrl: 'http://localhost:11434/v1' });
  assert.deepEqual(config.profileModels, { fast: 'gpt-5-mini' });
});

test('accepts provider/model when the provider is declared', () => {
  assert.equal(validateCodexModel('deepseek/deepseek-chat', config, { DEEPSEEK_API_KEY: 'x' }).level, 'ok');
  // 未声明 env_key 的 provider 无需环境变量
  assert.equal(validateCodexModel('ollama/qwen3', config, {}).level, 'ok');
});

test('errors on undeclared provider', () => {
  const verdict = validateCodexModel('mistral/mistral-large', config, {});
  assert.equal(verdict.level, 'error');
  assert.match(verdict.message, /\[model_providers\.mistral\]/);
});

test('errors when env_key is not set', () => {
  const verdict = validateCodexModel('deepseek/deepseek-chat', config, {});
  assert.equal(verdict.level, 'error');
  assert.match(verdict.message, /DEEPSEEK_API_KEY/);
});

test('accepts bare models matching default or profile models', () => {
  assert.equal(validateCodexModel('gpt-5.6-terra', config, {}).level, 'ok');
  assert.equal(validateCodexModel('gpt-5-mini', config, {}).level, 'ok');
});

test('warns on unverifiable bare models', () => {
  const verdict = validateCodexModel('gpt-6', config, {});
  assert.equal(verdict.level, 'warning');
});

test('accepts OpenAI default-family naming without any config', () => {
  assert.equal(validateCodexModel('gpt-5.6-terra', null, {}).level, 'ok');
  assert.equal(validateCodexModel('o3', null, {}).level, 'ok');
  assert.equal(validateCodexModel('gpt-5.6-terra', { providers: {}, profileModels: {} }, {}).level, 'ok');
});

test('errors on provider references when config is missing', () => {
  const verdict = validateCodexModel('deepseek/deepseek-chat', null, {});
  assert.equal(verdict.level, 'error');
  assert.match(verdict.message, /not declared/);
});

test('warns on unrecognized bare models with default provider', () => {
  const bare = parseCodexConfig('model_provider = "deepseek"\n\n[model_providers.deepseek]\nenv_key = "DEEPSEEK_API_KEY"\n');
  assert.equal(validateCodexModel('some-unknown-model', bare, { DEEPSEEK_API_KEY: 'x' }).level, 'warning');
  assert.equal(validateCodexModel('some-unknown-model', null, {}).level, 'warning');
});

test('errors when model_provider points to an undeclared provider', () => {
  const broken = parseCodexConfig('model = "chat"\nmodel_provider = "ghost"\n');
  const verdict = validateCodexModel('chat', broken, {});
  assert.equal(verdict.level, 'error');
  assert.match(verdict.message, /ghost/);
});

test('parser skips unsupported toml syntax safely', () => {
  const messy = parseCodexConfig([
    '[model_providers.x]',
    'tags = ["a", "b"]',
    'nested = { inline = "table" }',
    "single = 'quoted'",
    'env_key = "X_KEY"',
    '  # indented comment'
  ].join('\n'));
  assert.equal(messy.providers.x?.envKey, 'X_KEY');
});
