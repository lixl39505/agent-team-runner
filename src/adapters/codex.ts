import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AdapterConfig, AgentInvocation, AgentRunResult } from '../core/types.js';
import type { AgentAdapter } from './types.js';
import { parseJsonLoose, spawnAgentProcess } from './process.js';

export class CodexAdapter implements AgentAdapter {
  constructor(private readonly config: AdapterConfig) {}

  async run<T>(input: AgentInvocation): Promise<AgentRunResult<T>> {
    const schemaPath = `${input.outputPath}.schema.json`;
    writeFileSync(schemaPath, `${JSON.stringify(input.schema, null, 2)}\n`, 'utf8');
    const readOnly = input.role === 'lead' || input.role === 'reviewer';
    const args = [
      ...(this.config.extraArgs ?? []),
      'exec',
      '--json',
      '--sandbox', readOnly ? 'read-only' : 'workspace-write',
      '--ask-for-approval', 'never',
      '--output-schema', schemaPath,
      '-o', input.outputPath
    ];
    if (this.config.model) args.push('--model', this.config.model);
    args.push(input.prompt);
    const result = await spawnAgentProcess<T>(input, this.config.command, args);
    if (result.exitCode === 0) {
      const raw = existsSync(input.outputPath) ? readFileSync(input.outputPath, 'utf8') : result.rawOutput;
      result.output = parseJsonLoose(raw) as T;
    }
    return result;
  }
}
