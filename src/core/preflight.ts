import { spawn } from 'node:child_process';
import type { AdapterName, ResolvedProfile, RunnerConfig } from './types.js';
import { readCodexConfig, validateCodexModel } from './codex-config.js';
import { readClaudeSettings, validateClaudeModel } from './claude-config.js';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

interface CliProbe {
  code: number;
  stdout: string;
}

function execWithTimeout(program: string, args: string[], cwd: string, timeoutMs: number): Promise<CliProbe> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ code: 127, stdout: '' });
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 124, stdout });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 127, stdout }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
  });
}

/**
 * 预检一组已解析的 profile：
 * - CLI 未安装 → error（直接阻止启动）
 * - opencode 的 model 未出现在 `opencode models` 列表 → error（该命令是权威列表）
 * - codex 的 model 通过 ~/.codex/config.toml 静态校验：provider 未声明 / env_key 缺失 → error，
 *   OpenAI 默认命名（gpt、o、codex 前缀）或与已配置 model 一致 → ok，其余无法枚举 → warning
 * - claude 的 model 通过 ~/.claude/settings.json 静态校验：非 claude 命名且无 ANTHROPIC_BASE_URL 网关 → error，
 *   网关后的自定义模型无法枚举 → warning
 */
export async function checkProfileAvailability(
  config: RunnerConfig,
  profiles: ResolvedProfile[]
): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cliAvailable = new Map<AdapterName, boolean>();
  let codexConfig: ReturnType<typeof readCodexConfig> | undefined;
  let claudeSettings: ReturnType<typeof readClaudeSettings> | undefined;
  for (const profile of profiles) {
    const command = config.adapters[profile.cli].command;
    if (!cliAvailable.has(profile.cli)) {
      const probe = await execWithTimeout(command, ['--version'], config.repoRoot, 10_000);
      const available = probe.code === 0;
      cliAvailable.set(profile.cli, available);
      if (!available) {
        errors.push(`cli "${profile.cli}" (${command}) is not available locally; install it or choose another profile`);
      }
    }
    if (!profile.model || !cliAvailable.get(profile.cli)) continue;
    if (profile.cli === 'opencode') {
      const probe = await execWithTimeout(command, ['models'], config.repoRoot, 30_000);
      if (probe.code === 0 && probe.stdout.trim().length > 0 && !probe.stdout.includes(profile.model)) {
        errors.push(`model "${profile.model}" is not listed by \`opencode models\`; check the model id or provider auth`);
      }
    } else if (profile.cli === 'codex') {
      codexConfig ??= readCodexConfig();
      const verdict = validateCodexModel(profile.model, codexConfig);
      if (verdict.level === 'error') errors.push(verdict.message!);
      else if (verdict.level === 'warning') warnings.push(verdict.message!);
    } else {
      claudeSettings ??= readClaudeSettings();
      const verdict = validateClaudeModel(profile.model, claudeSettings);
      if (verdict.level === 'error') errors.push(verdict.message!);
      else if (verdict.level === 'warning') warnings.push(verdict.message!);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
