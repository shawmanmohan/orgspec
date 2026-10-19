import { asArray, type Operations, pick } from './tools.js';

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  type?: string;
  assignee?: { accountId?: string; name?: string; email?: string };
  reporter?: { accountId?: string; name?: string };
  priority?: string;
  labels: string[];
  updated: string;
  created?: string;
  due?: string;
  parent?: string;
  project: string;
  /** Raw fields for gate fields and anything else configured. */
  fields: Record<string, unknown>;
}

export function normalizeIssue(raw: unknown): JiraIssue {
  const f = (pick<Record<string, unknown>>(raw, 'fields') ?? {}) as Record<string, unknown>;
  const key = pick<string>(raw, 'key') ?? '';
  const assignee = pick<Record<string, unknown>>(f, 'assignee');
  const reporter = pick<Record<string, unknown>>(f, 'reporter');
  const due = pick<string>(f, 'duedate');
  const parent = pick<string>(f, 'parent.key');
  const created = pick<string>(f, 'created');
  const statusCategory = pick<string>(f, 'status.statusCategory.key');
  const type = pick<string>(f, 'issuetype.name');
  const priority = pick<string>(f, 'priority.name');
  return {
    key,
    summary: pick<string>(f, 'summary') ?? '',
    status: pick<string>(f, 'status.name') ?? 'Unknown',
    ...(statusCategory ? { statusCategory } : {}),
    ...(type ? { type } : {}),
    ...(assignee
      ? {
          assignee: {
            accountId: pick<string>(assignee, 'accountId'),
            name: pick<string>(assignee, 'displayName'),
            email: pick<string>(assignee, 'emailAddress'),
          },
        }
      : {}),
    ...(reporter
      ? { reporter: { accountId: pick<string>(reporter, 'accountId'), name: pick<string>(reporter, 'displayName') } }
      : {}),
    ...(priority ? { priority } : {}),
    labels: asArray(f.labels).map(String),
    updated: pick<string>(f, 'updated') ?? new Date(0).toISOString(),
    ...(created ? { created } : {}),
    ...(due ? { due } : {}),
    ...(parent ? { parent } : {}),
    project: pick<string>(f, 'project.key') ?? key.split('-')[0] ?? '',
    fields: f,
  } as JiraIssue;
}

/** Jira through the Atlassian MCP server. OrgSpec only reads issues and keeps its gate fields current. */
export class Jira {
  constructor(private readonly ops: Operations) {}

  async search(jql: string, opts: { fields?: string[]; limit?: number } = {}): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    let cursor: string | undefined;
    const limit = opts.limit ?? 200;
    do {
      const res = await this.ops.run('jira.searchIssues', {
        jql,
        fields: opts.fields ?? [
          'summary',
          'status',
          'assignee',
          'reporter',
          'issuetype',
          'priority',
          'labels',
          'updated',
          'created',
          'duedate',
          'parent',
          'project',
        ],
        limit: Math.min(100, limit - out.length),
        cursor,
      });
      out.push(...asArray(pick(res, 'issues', 'values', 'results')).map(normalizeIssue));
      cursor = pick<string>(res, 'nextPageToken');
    } while (cursor && out.length < limit);
    return out;
  }

  async get(key: string, fields?: string[]): Promise<JiraIssue> {
    return normalizeIssue(await this.ops.run('jira.getIssue', { key, fields }));
  }

  /** Writes fields (gate fields such as `customfield_10420`). */
  async setFields(key: string, fields: Record<string, unknown>): Promise<void> {
    await this.ops.run('jira.editIssue', { key, fields });
  }

  async comment(key: string, body: string): Promise<void> {
    await this.ops.run('jira.addComment', { key, body });
  }

  /** `inward` is blocked by `outward` (link type "Blocks" by default). */
  async link(inward: string, outward: string, type = 'Blocks'): Promise<void> {
    await this.ops.run('jira.linkIssues', { inward, outward, type });
  }

  async create(input: {
    project: string;
    type: string;
    summary: string;
    description?: string;
    fields?: Record<string, unknown>;
  }): Promise<string> {
    const res = await this.ops.run('jira.createIssue', input);
    const key = pick<string>(res, 'key', 'issue.key');
    if (!key) throw new Error('Jira did not return the new issue key');
    return key;
  }
}

export interface ConfluencePage {
  id: string;
  title: string;
  version: number;
  spaceId?: string;
  storage: string;
  url?: string;
  updated?: string;
}

export function normalizePage(raw: unknown): ConfluencePage {
  const spaceId = pick<string>(raw, 'spaceId', 'space.id');
  const url = pick<string>(raw, '_links.webui', 'webUrl', 'url');
  const updated = pick<string>(raw, 'version.createdAt', 'version.when', 'lastModified');
  return {
    id: String(pick(raw, 'id') ?? ''),
    title: pick<string>(raw, 'title') ?? '',
    version: Number(pick(raw, 'version.number', 'version') ?? 0),
    storage: pick<string>(raw, 'body.storage.value', 'body.value', 'body') ?? '',
    ...(spaceId ? { spaceId } : {}),
    ...(url ? { url } : {}),
    ...(updated ? { updated } : {}),
  };
}

/** Confluence through the Atlassian MCP server: constitution sources, PRD reviews and 1:1 pages. */
export class Confluence {
  constructor(private readonly ops: Operations) {}

  async get(pageId: string): Promise<ConfluencePage> {
    return normalizePage(await this.ops.run('confluence.getPage', { pageId }));
  }

  async search(cql: string, limit = 50): Promise<{ id: string; title: string; version?: number }[]> {
    const res = await this.ops.run('confluence.search', { cql, limit });
    return asArray(pick(res, 'results', 'pages')).map((r) => {
      const content = pick<Record<string, unknown>>(r, 'content') ?? r;
      const version = pick<number>(content, 'version.number');
      return {
        id: String(pick(content, 'id') ?? ''),
        title: pick<string>(content, 'title') ?? '',
        ...(version !== undefined ? { version } : {}),
      };
    });
  }

  async create(input: { spaceId: string; parentId?: string; title: string; body: string }): Promise<ConfluencePage> {
    return normalizePage(await this.ops.run('confluence.createPage', input));
  }

  async update(input: { pageId: string; title: string; body: string; message?: string }): Promise<ConfluencePage> {
    return normalizePage(await this.ops.run('confluence.updatePage', input));
  }

  /** Adds a footer comment, as the person. */
  async comment(pageId: string, body: string): Promise<void> {
    await this.ops.run('confluence.addComment', { pageId, body });
  }

  /** Limits a page to the given account IDs (1:1 pages: manager and report only). */
  async restrict(pageId: string, users: string[]): Promise<void> {
    await this.ops.run('confluence.setRestrictions', { pageId, users });
  }

  async comments(pageId: string): Promise<{ id: string; author?: string; body: string; created?: string }[]> {
    const res = await this.ops.run('confluence.getComments', { pageId });
    return asArray(pick(res, 'results', 'comments')).map((c) => {
      const author = pick<string>(c, 'version.authorId', 'author.displayName');
      const created = pick<string>(c, 'version.createdAt', 'created');
      return {
        id: String(pick(c, 'id') ?? ''),
        body: pick<string>(c, 'body.storage.value', 'body') ?? '',
        ...(author ? { author } : {}),
        ...(created ? { created } : {}),
      };
    });
  }
}
