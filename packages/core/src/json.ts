/**
 * Extracts the first JSON value from model output: a ```json fence if present, otherwise the
 * first balanced object or array.
 */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fence?.[1]) return JSON.parse(fence[1]);
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error('No JSON found in output');
  const open = text[start] as '{' | '[';
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('Unbalanced JSON in output');
}

export const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
