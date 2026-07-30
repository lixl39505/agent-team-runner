import { writeFileSync } from 'node:fs';
import type { AdapterConfig, AgentInvocation, AgentRunResult } from '../core/types.js';
import type { AgentAdapter } from './types.js';
import { parseJsonLoose, spawnAgentProcess } from './process.js';

export class OpenCodeAdapter implements AgentAdapter {
  constructor(private readonly config: AdapterConfig) {}

  async run<T>(input: AgentInvocation): Promise<AgentRunResult<T>> {
    const readOnly = input.role === 'lead' || input.role === 'reviewer';
    const prompt = `${input.prompt}\n\nReturn the final answer as one JSON object matching this schema exactly:\n${JSON.stringify(input.schema, null, 2)}`;
    const args = [
      ...(this.config.extraArgs ?? []),
      'run', '--dir', input.cwd, '--format', 'json', '--auto', '--agent', readOnly ? 'plan' : 'build'
    ];
    if (this.config.model) args.push('--model', this.config.model);
    args.push(prompt);
    const result = await spawnAgentProcess<T>(input, this.config.command, args);
    if (result.exitCode === 0) {
      result.output = parseJsonLoose(result.rawOutput) as T;
      writeFileSync(input.outputPath, `${JSON.stringify(result.output, null, 2)}\n`, 'utf8');
    }
    return result;
  }
}
