import { writeFileSync } from 'node:fs';
import type { AdapterConfig, AgentInvocation, AgentRunResult } from '../core/types.js';
import type { AgentAdapter } from './types.js';
import { parseJsonLoose, spawnAgentProcess } from './process.js';

export class ClaudeAdapter implements AgentAdapter {
  constructor(private readonly config: AdapterConfig, private readonly allowedCommandPrefixes: string[]) {}

  async run<T>(input: AgentInvocation): Promise<AgentRunResult<T>> {
    const readOnly = input.role === 'lead' || input.role === 'reviewer';
    const tools = readOnly
      ? ['Read', 'Glob', 'Grep', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git rev-parse *)', 'Bash(git ls-files *)']
      : [
          'Read', 'Glob', 'Grep', 'Edit', 'Write',
          'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)',
          ...this.allowedCommandPrefixes.map((prefix) => `Bash(${prefix} *)`)
        ];
    const args = [
      ...(this.config.extraArgs ?? []),
      '-p', input.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(input.schema),
      '--permission-mode', readOnly ? 'dontAsk' : 'acceptEdits',
      '--allowedTools', tools.join(',')
    ];
    if (this.config.model) args.push('--model', this.config.model);
    const result = await spawnAgentProcess<T>(input, this.config.command, args);
    if (result.exitCode === 0) {
      const wrapper = parseJsonLoose(result.rawOutput) as Record<string, unknown>;
      result.output = ((wrapper && typeof wrapper === 'object' && 'structured_output' in wrapper)
        ? wrapper.structured_output
        : wrapper) as T;
      writeFileSync(input.outputPath, `${JSON.stringify(result.output, null, 2)}\n`, 'utf8');
    }
    return result;
  }
}
