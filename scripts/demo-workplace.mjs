// A fictional workplace behind MCP, for trying OrgSpec without real systems.
// Usage (from integrations.yaml): command: node, args: [scripts/demo-workplace.mjs, <hr|calendar|atlassian|slack|ci>, <state.json>]
// Every person, ticket, page and message here is made up.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../packages/gateway/package.json'));
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const [kind = 'hr', stateFile = join(process.cwd(), 'demo-workplace.json')] = process.argv.slice(2);
const ME = process.env.DEMO_MANAGER ?? 'you@acme.io';
const ME_SLACK = 'U00YOU';
const DAY = 86_400_000;

/** A date `d` days from today at hh:mm local time. */
const at = (d, hh = 10, mm = 0) => {
  const t = new Date(Date.now() + d * DAY);
  t.setHours(hh, mm, 0, 0);
  return t.toISOString();
};
const nextWeekday = (dow, hh, mm = 0) => {
  const now = new Date();
  const d = (dow - now.getDay() + 7) % 7 || 7;
  return at(d, hh, mm);
};
const plus = (iso, mins) => new Date(Date.parse(iso) + mins * 60_000).toISOString();
const slackTs = (daysAgo, n = 0) => `${Math.floor((Date.now() - daysAgo * DAY) / 1000) + n}.${String(100000 + n).slice(1)}`;
const dateOnly = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);

function seed() {
  const people = [
    { email: ME, name: 'You', title: 'Engineering manager', team: 'payments', managerEmail: 'ravi.menon@acme.io', timezone: 'Asia/Kolkata' },
    { email: 'ravi.menon@acme.io', name: 'Ravi Menon', title: 'Director of engineering', team: 'payments', timezone: 'Europe/London' },
    { email: 'asha.rao@acme.io', name: 'Asha Rao', title: 'Senior engineer', team: 'payments', managerEmail: ME, timezone: 'Asia/Kolkata' },
    { email: 'jonas.weber@acme.io', name: 'Jonas Weber', title: 'Engineer', team: 'payments', managerEmail: ME, timezone: 'Europe/Berlin' },
    { email: 'lena.fischer@acme.io', name: 'Lena Fischer', title: 'Staff engineer', team: 'payments', managerEmail: ME, timezone: 'Europe/Berlin' },
    { email: 'marco.silva@acme.io', name: 'Marco Silva', title: 'Engineer', team: 'web', managerEmail: ME, timezone: 'Europe/Lisbon' },
    { email: 'dana.kim@acme.io', name: 'Dana Kim', title: 'Engineer', team: 'payments', managerEmail: ME, timezone: 'America/New_York', managerChange: { toName: 'Priya Nair', effective: dateOnly(12) } },
    { email: 'priya.nair@acme.io', name: 'Priya Nair', title: 'Ledger team lead', team: 'ledger', timezone: 'America/Los_Angeles' },
  ];
  const oneOnOne = (p, start, mins) => ({ id: `ev-${p.split('@')[0]}`, title: `1:1 ${p.split('.')[0]} / you`, start, end: plus(start, mins), attendees: [ME, p] });
  const events = [
    oneOnOne('asha.rao@acme.io', nextWeekday(4, 15), 30),
    oneOnOne('lena.fischer@acme.io', nextWeekday(1, 11), 45),
    oneOnOne('marco.silva@acme.io', nextWeekday(5, 10), 30),
    oneOnOne('dana.kim@acme.io', nextWeekday(2, 14), 30),
    { id: 'ev-ravi-past', title: '1:1 you / Ravi', start: at(-9, 16), end: at(-9, 16, 30), attendees: [ME, 'ravi.menon@acme.io'] },
    { id: 'ev-ravi', title: '1:1 you / Ravi', start: nextWeekday(4, 16), end: plus(nextWeekday(4, 16), 30), attendees: [ME, 'ravi.menon@acme.io'] },
    { id: 'ev-standup', title: 'Payments standup', start: at(1, 9, 30), end: at(1, 9, 45), attendees: [ME, 'asha.rao@acme.io', 'jonas.weber@acme.io'] },
    { id: 'ev-planning', title: 'Quarter planning', start: at(2, 13), end: at(2, 16), attendees: [ME] },
  ];
  const issue = (key, summary, status, assignee, updatedDaysAgo, o = {}) => ({
    key,
    fields: {
      summary,
      status: { name: status, statusCategory: { key: o.category ?? (status === 'Done' ? 'done' : status === 'To Do' ? 'new' : 'indeterminate') } },
      ...(assignee ? { assignee: { emailAddress: assignee, displayName: assignee.split('@')[0] } } : {}),
      reporter: { displayName: o.reporter ?? 'Lena Fischer' },
      updated: new Date(Date.now() - updatedDaysAgo * DAY).toISOString(),
      created: new Date(Date.now() - (updatedDaysAgo + 20) * DAY).toISOString(),
      project: { key: key.split('-')[0] },
      labels: o.labels ?? [],
      issuetype: { name: o.type ?? 'Story' },
      priority: { name: o.priority ?? 'Medium' },
      ...(o.parent ? { parent: { key: o.parent } } : {}),
      ...(o.due ? { duedate: o.due } : {}),
      ...(o.description ? { description: o.description } : {}),
      issuelinks: [...(o.blocks ?? []).map((k) => ({ type: { name: 'Blocks' }, outwardIssue: { key: k } })), ...(o.blockedBy ?? []).map((k) => ({ type: { name: 'Blocks' }, inwardIssue: { key: k } }))],
    },
  });
  const issues = [
    // Tickets assigned to you (the engineer view).
    issue('PAY-42', 'Retry failed card captures', 'In Progress', ME, 1, { priority: 'High', description: 'Captures fail on gateway 503s.\n\nAcceptance criteria:\n- A failed capture is retried at most 3 times\n- Retries use 2s, 4s and 8s backoff\n- No capture is charged twice' }),
    issue('PAY-131', 'Duplicate refunds on retry', 'Ready', ME, 2, { type: 'Bug', priority: 'High', description: 'Customer support saw two refunds for order 88231 after the client timed out and retried.\n\nAcceptance criteria:\n- A refund retried with the same idempotency key creates one refund\n- A retried request returns the original refund ID' }),
    issue('PAY-144', 'Evaluate a second card gateway', 'Ready', ME, 5, { type: 'Spike', priority: 'Low' }),
    issue('PAY-140', 'Store card tokens per region', 'Spec review', ME, 3, { priority: 'Medium' }),
    // People's work (1:1 briefs).
    issue('PROJ-119', 'Verify webhook signatures on capture callbacks', 'Done', 'asha.rao@acme.io', 3),
    issue('PROJ-102', 'Ledger reconciliation report for retried captures', 'In Progress', 'asha.rao@acme.io', 6),
    issue('PROJ-131', 'Retry cap decision: align payments and ledger', 'Done', 'asha.rao@acme.io', 9),
    // Program: Regional card tokens.
    issue('PAY-240', 'Regional card tokens', 'In Progress', 'lena.fischer@acme.io', 1, { type: 'Epic', due: dateOnly(40) }),
    issue('PAY-241', 'Token API for regional stores', 'Done', 'asha.rao@acme.io', 8, { parent: 'PAY-240' }),
    issue('PAY-243', 'Token lookup cache', 'Done', 'jonas.weber@acme.io', 12, { parent: 'PAY-240' }),
    issue('LED-58', 'Replicate token index to EU', 'To Do', undefined, 13, { parent: 'PAY-240', blocks: ['PAY-246', 'PAY-247', 'PAY-250', 'PAY-251'] }),
    issue('PAY-246', 'EU token write path', 'In Progress', 'asha.rao@acme.io', 9, { parent: 'PAY-240', blockedBy: ['LED-58'] }),
    issue('PAY-247', 'EU token read path', 'To Do', 'jonas.weber@acme.io', 9, { parent: 'PAY-240', blockedBy: ['LED-58'] }),
    issue('PAY-249', 'Vault key rotation per region', 'In Review', 'jonas.weber@acme.io', 4, { parent: 'PAY-240' }),
    issue('PAY-250', 'Region failover drill', 'To Do', 'lena.fischer@acme.io', 9, { parent: 'PAY-240', blockedBy: ['LED-58'] }),
    issue('PAY-251', 'Token migration tooling', 'To Do', undefined, 9, { parent: 'PAY-240', blockedBy: ['LED-58'] }),
    // Program: Webhook hardening (on track).
    issue('PAY-180', 'Webhook hardening', 'In Progress', 'asha.rao@acme.io', 1, { type: 'Epic', due: dateOnly(60) }),
    issue('PAY-181', 'Signature check', 'Done', 'asha.rao@acme.io', 3, { parent: 'PAY-180' }),
    issue('PAY-182', 'Replay protection', 'Done', 'asha.rao@acme.io', 6, { parent: 'PAY-180' }),
    issue('PAY-183', 'Webhook retry with jitter', 'In Review', 'lena.fischer@acme.io', 1, { parent: 'PAY-180' }),
    issue('PAY-212', 'Retry rate dashboard panel', 'To Do', 'jonas.weber@acme.io', 4),
  ];
  const prd = (id, title, version, author, epic, body) => ({ id, title, version, labels: ['prd-review'], body: `<p>Author: ${author}. Epic: ${epic}.</p>${body}` });
  const pages = {
    'p-asha': {
      id: 'p-asha',
      title: `1:1 ${ME} / asha.rao@acme.io`,
      version: 4,
      body: `<p>Shared agenda for Asha Rao and their manager. Only the two of you can see this page.</p><h2>Agenda</h2><ul><li>On-call load this quarter <em>· Asha</em></li><li>Design review practice <em>· you</em></li></ul><h2>Goals</h2><ul><li>Lead a cross-team design</li><li>Mentor a newer engineer</li></ul><h2>Context from Asha Rao</h2><p>On call 13–17 Oct and handled the capture incident; PROJ-102 moved by agreement.</p>`,
    },
    'p-lena': { id: 'p-lena', title: `1:1 ${ME} / lena.fischer@acme.io`, version: 2, body: '<h2>Agenda</h2><ul><li>Staff project scope <em>· Lena</em></li></ul><h2>Goals</h2><ul><li>Own the refunds platform roadmap</li></ul><h2>Context from Lena Fischer</h2><p></p>' },
    'p-me': {
      id: 'p-me',
      title: `1:1 ravi.menon@acme.io / ${ME}`,
      version: 3,
      body: '<h2>Agenda</h2><ul><li>Hiring plan for Q1 <em>· Ravi</em></li></ul><h2>Goals</h2><ul><li>Grow two engineers to senior</li><li>Cut PRD review time below 5 days</li></ul><h2>Context from You</h2><p></p>',
    },
    'p-career': {
      id: 'p-career',
      title: 'Engineering career ladder',
      version: 3,
      body: '<h2>Senior engineer</h2><p>Leads designs across teams; brings owning teams in at draft stage; mentors newer engineers; raises the bar in reviews.</p><h2>Staff engineer</h2><p>Sets technical direction for a domain; aligns several teams on a decision.</p>',
    },
    '100001': {
      id: '100001',
      title: 'Engineering handbook',
      version: 41,
      body: '<h1>Engineering handbook</h1><h2>Branches</h2><p>Never force-push to a branch someone else may have pulled. Agents and people push ticket branches only; pull requests start as drafts and a person marks them ready.</p><h2>Testing</h2><p>Every behaviour change ships with a test that names the scenario it covers.</p><h2>Secrets</h2><p>Credentials never go into source control.</p><h2>Pull requests</h2><p>Prefer small pull requests that are easy to review.</p>',
    },
    '100002': {
      id: '100002',
      title: 'Change management',
      version: 10,
      body: '<h1>Change management</h1><p>Pipeline definitions change only through a reviewed change. Schema migrations are always high risk and need a high-tier change. High-risk designs are approved by a staff engineer before work starts. Describe how you would roll back any change that touches production data.</p>',
    },
    '200001': {
      id: '200001',
      title: 'Payments engineering standards',
      version: 7,
      body: '<h1>Payments engineering standards</h1><p>Every capture, refund and payout call carries an idempotency key. Payments code never logs a full card number.</p>',
    },
    '300001': {
      id: '300001',
      title: 'How we write PRDs',
      version: 20,
      body: '<h1>How we write PRDs</h1><p>State how you will measure success, with a target. List what you are not doing. State latency targets for anything a user waits on. Say how you will roll out and how you would roll back. Reviewers respond within five working days.</p>',
    },
    'p-prd-tokens': prd(
      'p-prd-tokens',
      'Regional card token storage',
      12,
      'Lena Fischer',
      'PAY-240',
      '<h2>Problem</h2><p>Merchants in the EU must keep card tokens in the EU.</p><h2>Proposal</h2><p>Store tokens per region and route lookups to the nearest region. Lookups should feel instant for merchants.</p><h2>Rollout</h2><p>Enable regions one at a time.</p><h2>Dependencies</h2><p>token-vault service (platform security reviewed v10); ledger replication (not yet discussed).</p>',
    ),
    'p-prd-refunds': prd(
      'p-prd-refunds',
      'Partial refunds in the merchant portal',
      4,
      'Marco Silva',
      'WEB-30',
      '<h2>Problem</h2><p>Merchants can only refund the full amount.</p><h2>Proposal</h2><p>Let merchants refund any amount up to the remaining captured total from the portal.</p><h2>Success metrics</h2><p>30% of refund support tickets disappear within a quarter.</p><h2>Non-goals</h2><p>No partial refunds through the API in this phase.</p>',
    ),
  };
  const channels = {
    'D-asha': [
      { ts: slackTs(1, 1), user: 'U03ASHA', text: 'Can you sanity-check the 2s/4s/8s backoff before Thursday’s demo? I’m blocked on the config PR.' },
    ],
    'D-lena': [
      { ts: slackTs(2, 1), user: 'U04LENA', text: 'Could you send me the runbook link for retries?' },
      { ts: slackTs(2, 2), user: ME_SLACK, text: 'Sure, I’ll send it tomorrow.' },
    ],
    'D-marco': [{ ts: slackTs(0.5, 1), user: 'U05MARCO', text: 'Which region does the ledger replica live in? Need it for LED-41.' }],
    'D-dana': [
      { ts: slackTs(1.5, 1), user: 'U06DANA', text: 'Can we swap on-call on the 24th?' },
      { ts: slackTs(1.4, 2), user: ME_SLACK, text: 'Yes, swapped.' },
    ],
    'C-payments-eng': [
      { ts: slackTs(3, 1), user: 'U07PRIYA', text: 'Proposal: cap capture retries at 3 attempts with 2s, 4s, 8s backoff. 5 attempts hit the gateway rate limit on the 14th.' },
      { ts: slackTs(3, 2), user: 'U02JONAS', text: 'Agree, 3 attempts. I’ll write up the incident notes by Friday.' },
      { ts: slackTs(3, 3), user: 'U07PRIYA', text: 'Agreed then: 3 attempts. @you can you update the retry config by Wednesday?' },
      { ts: slackTs(2, 1), user: 'U02JONAS', text: 'Still no root cause for the 14 Oct spike; asked the gateway team.' },
      { ts: slackTs(1, 1), user: 'U03ASHA', text: 'We should alert when the retry rate passes a threshold.' },
    ],
  };
  return { people, events, issues, pages, channels, saved: [{ channel: 'C-payments-eng', ts: slackTs(1, 1) }], posted: [], created: [], comments: [], links: [], counter: 300 };
}

const load = () =>
  existsSync(stateFile)
    ? (() => {
        // Pages added to the seed later appear in existing demo state too.
        const st = JSON.parse(readFileSync(stateFile, 'utf8'));
        const fresh = seed().pages;
        let changed = false;
        for (const [id, page] of Object.entries(fresh)) if (!st.pages[id]) ((st.pages[id] = page), (changed = true));
        if (changed) writeFileSync(stateFile, JSON.stringify(st, null, 2));
        return st;
      })()
    : (() => {
        const s = seed();
        writeFileSync(stateFile, JSON.stringify(s, null, 2));
        return s;
      })();
const save = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2));
const obj = (props = {}, required = []) => ({ type: 'object', properties: props, required });
const str = { type: 'string' };
const arr = { type: 'array', items: str };

const TOOLS = {
  hr: {
    get_person: { schema: obj({ email: str }, ['email']), run: (s, a) => s.people.find((p) => p.email === a.email) ?? { error: 'not found' } },
    list_reports: { schema: obj({ managerEmail: str }, ['managerEmail']), run: (s, a) => ({ reports: s.people.filter((p) => p.managerEmail === a.managerEmail) }) },
    get_time_off: { schema: obj({ email: str, from: str, to: str }), run: (_s, a) => ({ periods: a.email === 'asha.rao@acme.io' ? [{ from: at(20, 0), to: at(24, 0) }] : [] }) },
    request_manager_change: {
      schema: obj({ email: str, newManagerEmail: str, note: str }, ['email']),
      run: (s, a) => {
        s.created.push({ kind: 'manager-change', ...a });
        save(s);
        return { ok: true, request: `HR-${++s.counter}` };
      },
    },
  },
  calendar: {
    list_events: {
      schema: obj({ from: str, to: str, query: str }),
      run: (s, a) => ({ events: s.events.filter((e) => (!a.from || e.start >= a.from) && (!a.to || e.start <= a.to) && (!a.query || e.title.includes(a.query))) }),
    },
    free_busy: {
      schema: obj({ attendees: arr, from: str, to: str }, ['attendees']),
      run: (s, a) => ({ calendars: Object.fromEntries((a.attendees ?? []).map((who) => [who, { busy: s.events.filter((e) => e.attendees.includes(who)).map((e) => ({ start: e.start, end: e.end })) }])) }),
    },
    create_event: {
      schema: obj({ title: str, start: str, end: str, attendees: arr, recurrence: str, description: str }, ['title', 'start', 'end']),
      run: (s, a) => {
        const ev = { id: `ev-${Date.now()}`, title: a.title, start: a.start, end: a.end, attendees: a.attendees ?? [], recurrence: a.recurrence };
        s.events.push(ev);
        s.created.push({ kind: 'event', id: ev.id });
        save(s);
        return ev;
      },
    },
  },
  atlassian: {
    searchJiraIssuesUsingJql: {
      schema: obj({ cloudId: str, jql: str, maxResults: { type: 'number' } }, ['jql']),
      run: (s, a) => {
        const jql = a.jql ?? '';
        const who = /assignee\s*=\s*"([^"]+)"/.exec(jql)?.[1] ?? (/assignee\s*=\s*currentUser\(\)/.test(jql) ? ME : undefined);
        const proj = /project\s*=\s*([A-Z]+)/.exec(jql)?.[1];
        const words = /summary\s*~\s*"([^"]+)"/.exec(jql)?.[1]?.toLowerCase().split(/\s+/).filter((w) => w.length > 3) ?? [];
        const openOnly = /statusCategory\s*!=\s*Done/i.test(jql);
        return {
          issues: s.issues.filter(
            (i) =>
              (!who || i.fields.assignee?.emailAddress === who || (/OR project in/.test(jql) && !proj)) &&
              (!proj || i.key.startsWith(`${proj}-`)) &&
              (!words.length || words.filter((w) => i.fields.summary.toLowerCase().includes(w)).length >= Math.min(2, words.length)) &&
              (!openOnly || i.fields.status.statusCategory.key !== 'done'),
          ),
        };
      },
    },
    getJiraIssue: { schema: obj({ cloudId: str, issueIdOrKey: str }, ['issueIdOrKey']), run: (s, a) => s.issues.find((i) => i.key === a.issueIdOrKey) ?? { key: a.issueIdOrKey, fields: { summary: `Demo ticket ${a.issueIdOrKey}`, status: { name: 'In Progress' }, issuetype: { name: 'Story' }, project: { key: String(a.issueIdOrKey).split('-')[0] } } } },
    editJiraIssue: { schema: obj({ cloudId: str, issueIdOrKey: str, fields: { type: 'object' } }), run: (s, a) => (s.created.push({ kind: 'edit', key: a.issueIdOrKey, fields: a.fields }), save(s), { ok: true }) },
    addCommentToJiraIssue: { schema: obj({ cloudId: str, issueIdOrKey: str, commentBody: str }), run: (s, a) => (s.comments.push({ on: a.issueIdOrKey, body: a.commentBody }), save(s), { ok: true }) },
    createJiraIssue: {
      schema: obj({ cloudId: str, projectKey: str, issueTypeName: str, summary: str, description: str }, ['projectKey', 'summary']),
      run: (s, a) => {
        const key = `${a.projectKey}-${++s.counter}`;
        s.issues.push({ key, fields: { summary: a.summary, status: { name: 'To Do', statusCategory: { key: 'new' } }, project: { key: a.projectKey }, issuetype: { name: a.issueTypeName ?? 'Story' }, updated: new Date().toISOString(), labels: [], issuelinks: [] } });
        s.created.push({ kind: 'issue', key, type: a.issueTypeName });
        save(s);
        return { key };
      },
    },
    createIssueLink: { schema: obj({ cloudId: str, inwardIssue: str, outwardIssue: str, type: str }), run: (s, a) => (s.links.push(a), save(s), { ok: true }) },
    getConfluencePage: {
      schema: obj({ cloudId: str, pageId: str }, ['pageId']),
      run: (s, a) => {
        const p = s.pages[a.pageId];
        if (!p) throw new Error(`No page ${a.pageId}`);
        return { id: p.id, title: p.title, version: { number: p.version }, body: { storage: { value: p.body } } };
      },
    },
    createConfluencePage: {
      schema: obj({ cloudId: str, spaceId: str, title: str, body: str }, ['title', 'body']),
      run: (s, a) => {
        const id = `p-${Date.now()}`;
        s.pages[id] = { id, title: a.title, version: 1, body: a.body };
        save(s);
        return { id, title: a.title, version: { number: 1 }, body: { storage: { value: a.body } } };
      },
    },
    updateConfluencePage: {
      schema: obj({ cloudId: str, pageId: str, title: str, body: str }, ['pageId', 'body']),
      run: (s, a) => {
        const p = s.pages[a.pageId];
        if (!p) throw new Error(`No page ${a.pageId}`);
        p.body = a.body;
        p.version += 1;
        if (a.title) p.title = a.title;
        save(s);
        return { id: p.id, title: p.title, version: { number: p.version }, body: { storage: { value: p.body } } };
      },
    },
    createConfluenceFooterComment: { schema: obj({ cloudId: str, pageId: str, body: str }), run: (s, a) => (s.comments.push({ on: a.pageId, body: a.body }), save(s), { ok: true }) },
    setConfluencePageRestrictions: { schema: obj({ cloudId: str, pageId: str, users: arr }), run: () => ({ ok: true }) },
    searchConfluenceUsingCql: {
      schema: obj({ cloudId: str, cql: str }),
      run: (s, a) => {
        const cql = a.cql ?? '';
        const label = /label\s*=\s*"([^"]+)"/.exec(cql)?.[1];
        const title = /title\s*~\s*"([^"]+)"/.exec(cql)?.[1];
        const list = Object.values(s.pages).filter((p) => (!label || (p.labels ?? []).includes(label)) && (!title || p.title.includes(title)));
        return { results: list.map((p) => ({ content: { id: p.id, title: p.title, version: { number: p.version } } })) };
      },
    },
  },
  slack: {
    conversations_list: { schema: obj({ types: str }), run: () => ({ channels: [{ id: 'D-asha', user: 'U03ASHA' }, { id: 'D-lena', user: 'U04LENA' }, { id: 'D-marco', user: 'U05MARCO' }, { id: 'D-dana', user: 'U06DANA' }] }) },
    conversations_history: {
      schema: obj({ channel: str, oldest: str, limit: { type: 'number' } }, ['channel']),
      run: (s, a) => {
        const id = s.channels[a.channel] ? a.channel : `C-${String(a.channel).replace(/^#/, '')}`;
        return { messages: (s.channels[id] ?? []).filter((m) => !a.oldest || Number(m.ts) > Number(a.oldest)).map((m) => ({ ...m, channel: id })) };
      },
    },
    conversations_replies: { schema: obj({ channel: str, ts: str }), run: (s, a) => ({ messages: (s.channels[a.channel] ?? []).filter((m) => Number(m.ts) >= Number(a.ts)) }) },
    chat_post_message: {
      schema: obj({ channel: str, text: str, thread_ts: str }, ['channel', 'text']),
      run: (s, a) => {
        const ts = `${Math.floor(Date.now() / 1000)}.000001`;
        s.posted.push({ channel: a.channel, text: a.text, thread: a.thread_ts, ts });
        save(s);
        return { ok: true, ts };
      },
    },
    users_info: { schema: obj({ user: str }), run: (_s, a) => ({ user: { id: a.user } }) },
    saved_list: { schema: obj({}), run: (s) => ({ items: s.saved.map((x) => ({ channel: x.channel, message: s.channels[x.channel]?.find((m) => m.ts === x.ts) })) }) },
  },
  ci: {
    list_runs: {
      schema: obj({ repo: str, branch: str, limit: { type: 'number' } }),
      run: (_s, a) => ({ runs: a.branch ? [{ id: `${a.branch}-1`, branch: a.branch, status: a.branch.includes('42') ? 'success' : 'running', steps: [{ name: 'orgspec check', status: 'success' }, { name: 'tests', status: 'success' }], url: `https://ci.acme.io/${a.repo}/${a.branch}` }] : [] }),
    },
    get_run: { schema: obj({ runId: str }), run: (_s, a) => ({ id: a.runId, status: 'success', steps: [] }) },
    get_run_logs: { schema: obj({ runId: str }), run: () => ({ logs: 'orgspec check: 0 errors' }) },
  },
};

const tools = TOOLS[kind];
if (!tools) {
  process.stderr.write(`unknown demo server ${kind}\n`);
  process.exit(2);
}
const server = new Server({ name: `demo-${kind}`, version: '0.2.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(tools).map(([name, t]) => ({ name, description: `Demo ${kind}: ${name}`, inputSchema: t.schema, annotations: { readOnlyHint: !/create|update|edit|add|set|post|request/i.test(name) } })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = tools[req.params.name];
  if (!t) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
  try {
    return { content: [{ type: 'text', text: JSON.stringify(t.run(load(), req.params.arguments ?? {})) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
});
await server.connect(new StdioServerTransport());
