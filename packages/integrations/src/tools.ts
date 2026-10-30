import type { Integrations, ToolMapping } from '@orgspec/core';

/** An MCP `tools/call` result. */
export interface ToolResult {
  content?: { type: string; text?: string; [k: string]: unknown }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Calls an upstream MCP tool by its namespaced name (`atlassian__getJiraIssue`). Implemented by the gateway's upstream pool. */
export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export class IntegrationError extends Error {
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(`${operation}: ${message}`);
  }
}

/** Parses a tool result: structured content first, then the first text block as JSON, then raw text. */
export function resultValue(r: ToolResult): unknown {
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = (r.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const VAR = /^\$([a-zA-Z_][a-zA-Z0-9_]*)$/;
const INLINE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** Fills `$name` (whole value) and `${name}` (inside strings) from input and constants; drops keys whose value is undefined. */
export function fillTemplate(template: unknown, vars: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    const whole = VAR.exec(template);
    if (whole) return vars[whole[1] as string];
    return template.replace(INLINE, (_m, n: string) => String(vars[n] ?? ''));
  }
  if (Array.isArray(template)) return template.map((t) => fillTemplate(t, vars)).filter((v) => v !== undefined);
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      const filled = fillTemplate(v, vars);
      if (filled !== undefined) out[k] = filled;
    }
    return out;
  }
  return template;
}

/**
 * Logical operations used by OrgSpec, mapped to upstream MCP tools. These defaults fit the Atlassian
 * remote MCP server, a Slack MCP server, and generic CI, HR and calendar servers; an org overrides any
 * of them in `integrations.yaml`.
 */
export const DEFAULT_OPERATIONS: Record<string, ToolMapping> = {
  'jira.searchIssues': {
    tool: 'atlassian__searchJiraIssuesUsingJql',
    args: { cloudId: '$cloudId', jql: '$jql', fields: '$fields', maxResults: '$limit', nextPageToken: '$cursor' },
  },
  'jira.getIssue': {
    tool: 'atlassian__getJiraIssue',
    args: { cloudId: '$cloudId', issueIdOrKey: '$key', fields: '$fields' },
  },
  'jira.editIssue': {
    tool: 'atlassian__editJiraIssue',
    args: { cloudId: '$cloudId', issueIdOrKey: '$key', fields: '$fields' },
  },
  'jira.addComment': {
    tool: 'atlassian__addCommentToJiraIssue',
    args: { cloudId: '$cloudId', issueIdOrKey: '$key', commentBody: '$body' },
  },
  'jira.transition': {
    tool: 'atlassian__transitionJiraIssue',
    args: { cloudId: '$cloudId', issueIdOrKey: '$key', transition: { id: '$transitionId' } },
  },
  'jira.createIssue': {
    tool: 'atlassian__createJiraIssue',
    args: {
      cloudId: '$cloudId',
      projectKey: '$project',
      issueTypeName: '$type',
      summary: '$summary',
      description: '$description',
      additional_fields: '$fields',
    },
  },
  'confluence.getPage': {
    tool: 'atlassian__getConfluencePage',
    args: { cloudId: '$cloudId', pageId: '$pageId', contentFormat: 'storage' },
  },
  'confluence.search': {
    tool: 'atlassian__searchConfluenceUsingCql',
    args: { cloudId: '$cloudId', cql: '$cql', limit: '$limit' },
  },
  'confluence.createPage': {
    tool: 'atlassian__createConfluencePage',
    args: {
      cloudId: '$cloudId',
      spaceId: '$spaceId',
      parentId: '$parentId',
      title: '$title',
      body: '$body',
      contentFormat: 'storage',
    },
  },
  'confluence.updatePage': {
    tool: 'atlassian__updateConfluencePage',
    args: {
      cloudId: '$cloudId',
      pageId: '$pageId',
      title: '$title',
      body: '$body',
      versionMessage: '$message',
      contentFormat: 'storage',
    },
  },
  'confluence.addComment': {
    tool: 'atlassian__createConfluenceFooterComment',
    args: { cloudId: '$cloudId', pageId: '$pageId', body: '$body' },
  },
  'jira.linkIssues': {
    tool: 'atlassian__createIssueLink',
    args: { cloudId: '$cloudId', inwardIssue: '$inward', outwardIssue: '$outward', type: '$type' },
  },
  'hr.requestManagerChange': {
    tool: 'hr__request_manager_change',
    args: { email: '$email', newManagerEmail: '$managerEmail', note: '$note' },
  },
  'confluence.getComments': {
    tool: 'atlassian__getConfluencePageFooterComments',
    args: { cloudId: '$cloudId', pageId: '$pageId' },
  },
  'confluence.setRestrictions': {
    tool: 'atlassian__setConfluencePageRestrictions',
    args: { cloudId: '$cloudId', pageId: '$pageId', users: '$users' },
  },
  'slack.listConversations': {
    tool: 'slack__conversations_list',
    args: { types: '$types', limit: '$limit', cursor: '$cursor' },
  },
  'slack.history': {
    tool: 'slack__conversations_history',
    args: { channel: '$channel', oldest: '$oldest', limit: '$limit', cursor: '$cursor' },
  },
  'slack.replies': { tool: 'slack__conversations_replies', args: { channel: '$channel', ts: '$ts' } },
  'slack.postMessage': {
    tool: 'slack__chat_post_message',
    args: { channel: '$channel', text: '$text', thread_ts: '$threadTs' },
  },
  'slack.saved': { tool: 'slack__saved_list', args: {} },
  'slack.getStatus': { tool: 'slack__users_profile_get', args: {} },
  'slack.setStatus': {
    tool: 'slack__users_profile_set',
    args: { status_text: '$text', status_emoji: '$emoji', status_expiration: '$expiration' },
  },
  'slack.setSnooze': { tool: 'slack__dnd_set_snooze', args: { num_minutes: '$minutes' } },
  'slack.endSnooze': { tool: 'slack__dnd_end_snooze', args: {} },
  'slack.userInfo': { tool: 'slack__users_info', args: { user: '$user' } },
  'ci.listRuns': {
    tool: 'ci__list_runs',
    args: { repo: '$repo', branch: '$branch', commit: '$commit', limit: '$limit' },
  },
  'ci.getRun': { tool: 'ci__get_run', args: { runId: '$runId' } },
  'ci.getLogs': { tool: 'ci__get_run_logs', args: { runId: '$runId', step: '$step' } },
  'ci.rerun': { tool: 'ci__rerun', args: { runId: '$runId' } },
  'hr.getPerson': { tool: 'hr__get_person', args: { email: '$email' } },
  'hr.listReports': { tool: 'hr__list_reports', args: { managerEmail: '$managerEmail' } },
  'hr.getTimeOff': { tool: 'hr__get_time_off', args: { email: '$email', from: '$from', to: '$to' } },
  'calendar.listEvents': { tool: 'calendar__list_events', args: { from: '$from', to: '$to', query: '$query' } },
  'calendar.freeBusy': { tool: 'calendar__free_busy', args: { attendees: '$attendees', from: '$from', to: '$to' } },
  'calendar.createEvent': {
    tool: 'calendar__create_event',
    args: {
      title: '$title',
      start: '$start',
      end: '$end',
      attendees: '$attendees',
      recurrence: '$recurrence',
      description: '$description',
    },
  },
};

/** Runs logical operations through a ToolCaller using the org's mapping. */
export class Operations {
  private readonly ops: Record<string, ToolMapping>;
  constructor(
    private readonly caller: ToolCaller,
    private readonly config: Pick<Integrations, 'operations' | 'constants'> = { operations: {}, constants: {} },
  ) {
    this.ops = { ...DEFAULT_OPERATIONS, ...config.operations };
  }

  has(op: string): boolean {
    return op in this.ops;
  }

  async run(op: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const mapping = this.ops[op];
    if (!mapping) throw new IntegrationError(op, 'no tool mapping; add one to integrations.yaml');
    const args = fillTemplate(mapping.args, { ...this.config.constants, ...input }) as Record<string, unknown>;
    let res: ToolResult;
    try {
      res = await this.caller.callTool(mapping.tool, args);
    } catch (e) {
      throw new IntegrationError(op, (e as Error).message);
    }
    const value = resultValue(res);
    if (res.isError)
      throw new IntegrationError(op, typeof value === 'string' ? value : JSON.stringify(value).slice(0, 500));
    return value;
  }
}

/** Reads the first defined value among dotted paths; tolerant of the shape differences between MCP servers. */
export function pick<T = unknown>(obj: unknown, ...paths: string[]): T | undefined {
  for (const p of paths) {
    let cur: unknown = obj;
    for (const k of p.split('.')) {
      if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[k];
      else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined && cur !== null) return cur as T;
  }
  return undefined;
}

export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
