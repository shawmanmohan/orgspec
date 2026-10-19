import { asArray, type Operations, pick } from './tools.js';

export interface SlackMessage {
  channel: string;
  ts: string;
  user?: string;
  text: string;
  threadTs?: string;
  replyCount?: number;
}

const normalizeMessage = (channel: string, m: unknown): SlackMessage => {
  const user = pick<string>(m, 'user', 'user_id');
  const threadTs = pick<string>(m, 'thread_ts');
  const replyCount = pick<number>(m, 'reply_count');
  return {
    channel,
    ts: String(pick(m, 'ts') ?? ''),
    text: pick<string>(m, 'text') ?? '',
    ...(user ? { user } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(replyCount !== undefined ? { replyCount } : {}),
  };
};

/** Slack through its MCP server. Read for summaries and the DM inbox; posting always needs confirmation. */
export class Slack {
  constructor(private readonly ops: Operations) {}

  async directConversations(limit = 200): Promise<{ id: string; user?: string }[]> {
    const res = await this.ops.run('slack.listConversations', { types: 'im,mpim', limit });
    return asArray(pick(res, 'channels', 'conversations')).map((c) => {
      const user = pick<string>(c, 'user');
      return { id: String(pick(c, 'id') ?? ''), ...(user ? { user } : {}) };
    });
  }

  async history(channel: string, oldest?: string, limit = 200): Promise<SlackMessage[]> {
    const res = await this.ops.run('slack.history', { channel, oldest, limit });
    return asArray(pick(res, 'messages')).map((m) => normalizeMessage(channel, m));
  }

  async replies(channel: string, ts: string): Promise<SlackMessage[]> {
    const res = await this.ops.run('slack.replies', { channel, ts });
    return asArray(pick(res, 'messages')).map((m) => normalizeMessage(channel, m));
  }

  async post(channel: string, text: string, threadTs?: string): Promise<string> {
    const res = await this.ops.run('slack.postMessage', { channel, text, threadTs });
    return String(pick(res, 'ts', 'message.ts') ?? '');
  }
}

export type CiState = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'unknown';

export interface CiRun {
  id: string;
  repo: string;
  branch?: string;
  commit?: string;
  state: CiState;
  url?: string;
  startedAt?: string;
  finishedAt?: string;
  steps: { name: string; state: CiState }[];
}

const STATE_WORDS: [RegExp, CiState][] = [
  [/^(success|succeeded|passed|pass|green|ok)$/i, 'passed'],
  [/^(fail|failed|failure|error|errored|red|broken)$/i, 'failed'],
  [/^(running|in_progress|in-progress|started|building)$/i, 'running'],
  [/^(queued|pending|waiting|scheduled)$/i, 'queued'],
  [/^(cancelled|canceled|aborted|skipped)$/i, 'cancelled'],
];
export const ciState = (raw: unknown): CiState => {
  const s = String(raw ?? '');
  return STATE_WORDS.find(([re]) => re.test(s))?.[1] ?? 'unknown';
};

export function normalizeRun(raw: unknown, repo = ''): CiRun {
  const branch = pick<string>(raw, 'branch', 'ref');
  const commit = pick<string>(raw, 'commit', 'sha', 'commitSha');
  const url = pick<string>(raw, 'url', 'webUrl', 'link');
  const startedAt = pick<string>(raw, 'startedAt', 'started_at', 'created');
  const finishedAt = pick<string>(raw, 'finishedAt', 'finished_at', 'completed');
  return {
    id: String(pick(raw, 'id', 'runId') ?? ''),
    repo: pick<string>(raw, 'repo', 'repository') ?? repo,
    state: ciState(pick(raw, 'state', 'status', 'conclusion', 'result')),
    steps: asArray(pick(raw, 'steps', 'jobs', 'stages')).map((s) => ({
      name: pick<string>(s, 'name') ?? '',
      state: ciState(pick(s, 'state', 'status', 'conclusion')),
    })),
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
    ...(url ? { url } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
  };
}

/** The org's own CI system through its MCP server. CI runs `orgspec check`; OrgSpec reads the results. */
export class Ci {
  constructor(private readonly ops: Operations) {}

  async runs(repo: string, opts: { branch?: string; commit?: string; limit?: number } = {}): Promise<CiRun[]> {
    const res = await this.ops.run('ci.listRuns', { repo, ...opts, limit: opts.limit ?? 20 });
    return asArray(Array.isArray(res) ? res : pick(res, 'runs', 'builds', 'pipelines')).map((r) =>
      normalizeRun(r, repo),
    );
  }

  async run(runId: string): Promise<CiRun> {
    return normalizeRun(await this.ops.run('ci.getRun', { runId }));
  }

  async logs(runId: string, step?: string): Promise<string> {
    const res = await this.ops.run('ci.getLogs', { runId, step });
    return typeof res === 'string' ? res : (pick<string>(res, 'logs', 'text') ?? JSON.stringify(res));
  }
}

export interface Person {
  email: string;
  name: string;
  title?: string;
  team?: string;
  managerEmail?: string;
  timezone?: string;
  /** A pending move to another manager, from the HR directory. */
  moveTo?: string;
  moveOn?: string;
}

const normalizePerson = (raw: unknown): Person => {
  const title = pick<string>(raw, 'title', 'jobTitle');
  const team = pick<string>(raw, 'team', 'department');
  const managerEmail = pick<string>(raw, 'managerEmail', 'manager.email');
  const timezone = pick<string>(raw, 'timezone', 'tz');
  const moveTo = pick<string>(raw, 'managerChange.toName', 'managerChange.to', 'pendingManager');
  const moveOn = pick<string>(raw, 'managerChange.effective', 'managerChangeDate');
  return {
    email: pick<string>(raw, 'email', 'workEmail') ?? '',
    name: pick<string>(raw, 'name', 'displayName', 'fullName') ?? '',
    ...(title ? { title } : {}),
    ...(team ? { team } : {}),
    ...(managerEmail ? { managerEmail } : {}),
    ...(timezone ? { timezone } : {}),
    ...(moveTo ? { moveTo } : {}),
    ...(moveOn ? { moveOn } : {}),
  };
};

/** HR directory through its MCP server: reporting lines for 1:1 rosters, time off for nudges. */
export class Hr {
  constructor(private readonly ops: Operations) {}

  async person(email: string): Promise<Person> {
    return normalizePerson(await this.ops.run('hr.getPerson', { email }));
  }

  async reports(managerEmail: string): Promise<Person[]> {
    const res = await this.ops.run('hr.listReports', { managerEmail });
    return asArray(Array.isArray(res) ? res : pick(res, 'reports', 'people', 'results')).map(normalizePerson);
  }

  async timeOff(email: string, from: string, to: string): Promise<{ from: string; to: string }[]> {
    const res = await this.ops.run('hr.getTimeOff', { email, from, to });
    return asArray(Array.isArray(res) ? res : pick(res, 'periods', 'entries')).map((p) => ({
      from: pick<string>(p, 'from', 'start') ?? '',
      to: pick<string>(p, 'to', 'end') ?? '',
    }));
  }
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
}

/** Calendar through its MCP server: finds upcoming 1:1s and free time. Creating events goes through a confirmation. */
export class Calendar {
  constructor(private readonly ops: Operations) {}

  /** Busy intervals per attendee email. */
  async busy(attendees: string[], from: string, to: string): Promise<Record<string, { start: string; end: string }[]>> {
    const res = await this.ops.run('calendar.freeBusy', { attendees, from, to });
    const out: Record<string, { start: string; end: string }[]> = {};
    const cals = (pick<Record<string, unknown>>(res, 'calendars', 'busy') ?? {}) as Record<string, unknown>;
    for (const a of attendees) {
      const entry = cals[a];
      const list = asArray(Array.isArray(entry) ? entry : pick(entry, 'busy'));
      out[a] = list.map((b) => ({ start: pick<string>(b, 'start') ?? '', end: pick<string>(b, 'end') ?? '' }));
    }
    return out;
  }

  async events(from: string, to: string, query?: string): Promise<CalendarEvent[]> {
    const res = await this.ops.run('calendar.listEvents', { from, to, query });
    return asArray(Array.isArray(res) ? res : pick(res, 'events', 'items')).map((e) => ({
      id: String(pick(e, 'id') ?? ''),
      title: pick<string>(e, 'title', 'summary') ?? '',
      start: pick<string>(e, 'start.dateTime', 'start') ?? '',
      end: pick<string>(e, 'end.dateTime', 'end') ?? '',
      attendees: asArray(pick(e, 'attendees')).map((a) =>
        typeof a === 'string' ? a : (pick<string>(a, 'email') ?? ''),
      ),
    }));
  }
}
