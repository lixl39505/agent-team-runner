/** 最终 agent 消息 → 结构化 JSON 的确定性解析（供 codex/opencode 的最终消息通道用） */
export function parseAgentJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* continue */ }
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].at(-1)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced.trim());
    } catch { /* continue */ }
  }
  const start = trimmed.lastIndexOf('{');
  if (start >= 0) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch { /* continue */ }
  }
  throw new Error('agent final message is not parseable JSON');
}
