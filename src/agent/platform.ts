import type { NativeWindowsSandboxPolicy } from '../core/types.js';
import type { PlatformCheckResult } from './types.js';

export function unsupportedNativeWindowsSandbox(
  backend: 'claude' | 'opencode',
  policy: NativeWindowsSandboxPolicy,
  platform: NodeJS.Platform
): PlatformCheckResult {
  if (platform !== 'win32') return { ok: true, degraded: false, detail: 'native Windows policy is not applicable' };
  const detail = `${backend} has no equivalent native Windows process sandbox; use WSL2 for strong isolation`;
  return policy === 'allow-degraded'
    ? { ok: true, degraded: true, detail: `${detail}; unsandboxed execution was explicitly allowed` }
    : { ok: false, degraded: false, detail: `${detail}, or set nativeWindowsSandbox: allow-degraded to opt in` };
}
