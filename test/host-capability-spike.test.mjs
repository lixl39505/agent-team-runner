import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'vitest';
import { createHostCapabilityRegistry, hostCapabilityNames, probeHostCapabilities } from '../src/host/capabilities.ts';

// Each command must exercise a real, logged-in Host and print all capabilities as JSON booleans.
// Its result remains an observation only and never enables an adapter declaration.
const hostSpike = process.env.AGENT_TEAM_HOST_SPIKE === '1' ? test : test.skip;

for (const [host, variable] of [
  ['claude-code', 'AGENT_TEAM_CLAUDE_CODE_SPIKE_COMMAND'],
  ['codex', 'AGENT_TEAM_CODEX_SPIKE_COMMAND'],
  ['opencode', 'AGENT_TEAM_OPENCODE_SPIKE_COMMAND']
] /** @type {const} */) {
  hostSpike(`${host} Host capability spike requires an external real-Host probe command`, async () => {
    const command = process.env[variable];
    assert.ok(command, `${variable} must run a real Host probe and print its JSON result`);
    const observed = JSON.parse(execFileSync(command, { shell: true, encoding: 'utf8' }).trim());
    const profile = await probeHostCapabilities(createHostCapabilityRegistry(), host, {
      async probe(_host, capability) {
        assert.equal(typeof observed[capability], 'boolean', `probe result must include boolean ${capability}`);
        return observed[capability];
      }
    });
    for (const capability of hostCapabilityNames) {
      assert.equal(profile.capabilities[capability].declared, false);
      assert.notEqual(profile.capabilities[capability].probe, 'unverified');
    }
  });
}
