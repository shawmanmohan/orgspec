import type { ToolResult } from '@orgspec/integrations';

/**
 * Wraps text from an upstream tool as data. Any tag that could close the wrapper early is defused so
 * page content cannot break out and pose as instructions.
 */
export function wrapUntrusted(result: ToolResult, source: string): ToolResult {
  const defuse = (t: string) => t.replace(/<\/?\s*untrusted[^>]*>/gi, (m) => m.replace('<', '&lt;'));
  const content = (result.content ?? []).map((c) =>
    c.type === 'text' && typeof c.text === 'string'
      ? { ...c, text: `<untrusted source="${source}">\n${defuse(c.text)}\n</untrusted>` }
      : c,
  );
  return { ...result, content };
}

const URL_RE = /\bhttps?:\/\/([a-z0-9.-]+)(?::\d+)?[^\s"'<>)]*/gi;

/** Hosts named in a tool call's arguments. */
export function hostsIn(value: unknown): string[] {
  const hosts = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(URL_RE)) hosts.add((m[1] as string).toLowerCase());
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return [...hosts];
}

const hostAllowed = (host: string, allow: readonly string[]) =>
  allow.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith('*.') ? host === p.slice(2) || host.endsWith(p.slice(1)) : host === p;
  });

/**
 * Egress check for calls that write: a URL in the arguments must point at a host the org allows or
 * the target server owns. Stops a poisoned page from steering data to an outside site.
 */
export function egressViolations(args: unknown, allow: readonly string[]): string[] {
  return hostsIn(args).filter((h) => !hostAllowed(h, allow));
}

/** Short, human-readable summary of a tool call for confirmation prompts. */
export function summarizeCall(server: string, tool: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== '')
    .slice(0, 6)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${s.length > 120 ? `${s.slice(0, 117)}…` : s}`;
    });
  return `${server} → ${tool}${parts.length ? `\n${parts.join('\n')}` : ''}`;
}
