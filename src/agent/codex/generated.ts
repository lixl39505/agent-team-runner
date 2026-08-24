import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 与 skills/ 加载相同的位置策略：从包根解析（src 与 dist 下均指向仓库根）
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * 协议类型生成时所针对的 codex 版本（`npm run gen:codex` 写入 protocol/GENERATED_FROM）。
 * 与 discover() 探测的实际 CLI 版本比对，不一致说明协议类型过期——
 * 升级流程：npm run gen:codex && npm run check。
 */
export function generatedProtocolVersion(): string | undefined {
  const path = join(packageRoot, 'src', 'agent', 'codex', 'protocol', 'GENERATED_FROM');
  try {
    const text = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}
