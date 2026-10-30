import {
  asArray,
  checkMappings,
  DEFAULT_OPERATIONS,
  type MappingIssue,
  pick,
  resultValue,
} from '@orgspec/integrations';
import type { AppContext } from './context.js';

export interface AtlassianSite {
  cloudId: string;
  url: string;
  name: string;
}

export interface IntegrationReport {
  server: string;
  tools: number;
  /** Operations mapped to this server. */
  operations: number;
  issues: MappingIssue[];
  /** Atlassian only: the sites this sign-in can reach, and whether `constants.cloudId` is one of them. */
  sites?: AtlassianSite[];
  cloudId?: { configured?: string; ok: boolean; suggested?: string };
}

const PLACEHOLDER = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

/**
 * Checks one MCP server against OrgSpec's operation mappings using its live tool list. For a server
 * that offers `getAccessibleAtlassianResources`, also checks `constants.cloudId` against the reachable sites.
 */
export async function checkIntegration(ctx: AppContext, server: string): Promise<IntegrationReport> {
  const ints = ctx.config()?.integrations;
  if (!ints?.servers[server]) throw new Error(`${server} is not in integrations.yaml`);
  const ops = { ...DEFAULT_OPERATIONS, ...ints.operations };
  const tools = await ctx.pool().tools(server);
  const report: IntegrationReport = {
    server,
    tools: tools.length,
    operations: Object.values(ops).filter((m) => m.tool.startsWith(`${server}__`)).length,
    issues: checkMappings(ops, server, tools),
  };
  if (tools.some((t) => t.name === 'getAccessibleAtlassianResources')) {
    const res = await ctx.pool().callTool(`${server}__getAccessibleAtlassianResources`, {});
    report.sites = asArray(resultValue(res)).map((s) => ({
      cloudId: pick<string>(s, 'id', 'cloudId') ?? '',
      url: pick<string>(s, 'url') ?? '',
      name: pick<string>(s, 'name') ?? '',
    }));
    const configured = ints.constants.cloudId;
    const hosts = ints.servers[server]?.hosts ?? [];
    const match =
      report.sites.find((s) => hosts.some((h) => s.url.includes(h))) ??
      (report.sites.length === 1 ? report.sites[0] : undefined);
    const ok = Boolean(
      configured && !PLACEHOLDER.test(configured) && report.sites.some((s) => s.cloudId === configured),
    );
    report.cloudId = {
      ...(configured ? { configured } : {}),
      ok,
      ...(!ok && match ? { suggested: match.cloudId } : {}),
    };
  }
  return report;
}

/** One line per problem, for the CLI and doctor. */
export function describeReport(r: IntegrationReport): string[] {
  const lines = r.issues.map((i) => `${i.operation} → ${i.tool}: ${i.detail}`);
  if (r.cloudId && !r.cloudId.ok)
    lines.push(
      r.cloudId.suggested
        ? `constants.cloudId should be "${r.cloudId.suggested}" (integrations.yaml)`
        : `constants.cloudId is not one of your sites: ${r.sites?.map((s) => `${s.url} = ${s.cloudId}`).join(', ') || 'none reachable'}`,
    );
  return lines;
}
