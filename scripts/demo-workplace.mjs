// A fictional workplace behind MCP, for trying OrgSpec without real systems.
// Usage (from integrations.yaml): command: node, args: [scripts/demo-workplace.mjs, <hr|calendar|atlassian>, <state.json>]
// Every person, ticket and page here is made up.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../packages/gateway/package.json'));
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const [kind = 'hr', stateFile = join(process.cwd(), 'demo-workplace.json')] = process.argv.slice(2);
const MANAGER = process.env.DEMO_MANAGER ?? 'you@acme.io';
const DAY = 86_400_000;

/** A date `d` days from today at hh:mm local time. */
const at = (d, hh, mm = 0) => {
  const t = new Date(Date.now() + d * DAY);
  t.setHours(hh, mm, 0, 0);
  return t.toISOString();
};
const nextWeekday = (dow, hh, mm = 0) => {
  const now = new Date();
  let d = (dow - now.getDay() + 7) % 7 || 7;
  if (d > 7) d -= 7;
  return at(d, hh, mm);
};
const plus = (iso, mins) => new Date(Date.parse(iso) + mins * 60_000).toISOString();

function seed() {
  const people = [
    { email: 'asha.rao@acme.io', name: 'Asha Rao', title: 'Senior engineer', team: 'payments', managerEmail: MANAGER },
    { email: 'jonas.weber@acme.io', name: 'Jonas Weber', title: 'Engineer', team: 'payments', managerEmail: MANAGER },
    { email: 'lena.fischer@acme.io', name: 'Lena Fischer', title: 'Staff engineer', team: 'payments', managerEmail: MANAGER },
    { email: 'marco.silva@acme.io', name: 'Marco Silva', title: 'Engineer', team: 'web', managerEmail: MANAGER },
    { email: 'dana.kim@acme.io', name: 'Dana Kim', title: 'Engineer · moves to Priya Nair on 1 Nov', team: 'payments', managerEmail: MANAGER },
  ];
  const oneOnOne = (p, start, mins) => ({ id: `ev-${p.split('@')[0]}`, title: `1:1 ${p.split('.')[0]} / you`, start, end: plus(start, mins), attendees: [MANAGER, p] });
  const events = [
    oneOnOne('asha.rao@acme.io', nextWeekday(4, 15), 30),
    oneOnOne('lena.fischer@acme.io', nextWeekday(1, 11), 45),
    oneOnOne('marco.silva@acme.io', nextWeekday(5, 10), 30),
    oneOnOne('dana.kim@acme.io', nextWeekday(2, 14), 30),
    { id: 'ev-standup', title: 'Payments standup', start: at(1, 9, 30), end: at(1, 9, 45), attendees: [MANAGER, 'asha.rao@acme.io', 'jonas.weber@acme.io'] },
    { id: 'ev-planning', title: 'Quarter planning', start: at(2, 13), end: at(2, 16), attendees: [MANAGER] },
  ];
  const issue = (key, summary, status, assignee, updatedDaysAgo, category = 'indeterminate') => ({
    key,
    fields: {
      summary,
      status: { name: status, statusCategory: { key: category } },
      assignee: { emailAddress: assignee, displayName: assignee.split('@')[0] },
      updated: new Date(Date.now() - updatedDaysAgo * DAY).toISOString(),
      project: { key: key.split('-')[0] },
      labels: [],
      issuetype: { name: 'Story' },
    },
  });
  const issues = [
    issue('PROJ-119', 'Verify webhook signatures on capture callbacks', 'Done', 'asha.rao@acme.io', 3, 'done'),
    issue('PROJ-102', 'Ledger reconciliation report for retried captures', 'In Progress', 'asha.rao@acme.io', 6),
    issue('PROJ-131', 'Retry cap decision: align payments and ledger', 'Done', 'asha.rao@acme.io', 9, 'done'),
    issue('PROJ-140', 'Add idempotency keys to refunds', 'In Review', 'lena.fischer@acme.io', 1),
    issue('PROJ-141', 'Refund API rate limits', 'To Do', 'jonas.weber@acme.io', 12, 'new'),
    issue('WEB-77', 'Checkout error states', 'In Progress', 'marco.silva@acme.io', 2),
  ];
  const pages = {
    'p-asha': {
      id: 'p-asha',
      title: `1:1 ${MANAGER} / asha.rao@acme.io`,
      version: 4,
      body: `<p>Shared agenda for Asha Rao and their manager. Only the two of you can see this page.</p><h2>Agenda</h2><ul><li>On-call load this quarter <em>· Asha</em></li><li>Design review practice <em>· you</em></li></ul><h2>Goals</h2><ul><li>Lead a cross-team design</li><li>Mentor a newer engineer</li></ul><h2>Context from Asha Rao</h2><p>On call 13–17 Oct and handled the capture incident; PROJ-102 moved by agreement.</p>`,
    },
    'p-lena': {
      id: 'p-lena',
      title: `1:1 ${MANAGER} / lena.fischer@acme.io`,
      version: 2,
      body: '<h2>Agenda</h2><ul><li>Staff project scope <em>· Lena</em></li></ul><h2>Goals</h2><ul><li>Own the refunds platform roadmap</li></ul><h2>Context from Lena Fischer</h2><p></p>',
    },
  };
  return { people, events, issues, pages, created: [] };
}

const load = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : (() => {
  const s = seed();
  writeFileSync(stateFile, JSON.stringify(s, null, 2));
  return s;
})());
const save = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2));
const obj = (props = {}, required = []) => ({ type: 'object', properties: props, required });
const str = { type: 'string' };

const TOOLS = {
  hr: {
    get_person: { schema: obj({ email: str }, ['email']), run: (s, a) => s.people.find((p) => p.email === a.email) ?? { error: 'not found' } },
    list_reports: { schema: obj({ managerEmail: str }, ['managerEmail']), run: (s, a) => ({ reports: s.people.filter((p) => p.managerEmail === a.managerEmail) }) },
    get_time_off: { schema: obj({ email: str, from: str, to: str }), run: (_s, a) => ({ periods: a.email === 'asha.rao@acme.io' ? [{ from: at(20, 0), to: at(24, 0) }] : [] }) },
  },
  calendar: {
    list_events: {
      schema: obj({ from: str, to: str, query: str }),
      run: (s, a) => ({ events: s.events.filter((e) => (!a.from || e.start >= a.from) && (!a.to || e.start <= a.to) && (!a.query || e.title.includes(a.query))) }),
    },
    free_busy: {
      schema: obj({ attendees: { type: 'array', items: str }, from: str, to: str }, ['attendees']),
      run: (s, a) => ({
        calendars: Object.fromEntries((a.attendees ?? []).map((who) => [who, { busy: s.events.filter((e) => e.attendees.includes(who)).map((e) => ({ start: e.start, end: e.end })) }])),
      }),
    },
    create_event: {
      schema: obj({ title: str, start: str, end: str, attendees: { type: 'array', items: str }, recurrence: str, description: str }, ['title', 'start', 'end']),
      run: (s, a) => {
        const ev = { id: `ev-${Date.now()}`, title: a.title, start: a.start, end: a.end, attendees: a.attendees ?? [], recurrence: a.recurrence };
        s.events.push(ev);
        s.created.push(ev.id);
        save(s);
        return ev;
      },
    },
  },
  atlassian: {
    searchJiraIssuesUsingJql: {
      schema: obj({ cloudId: str, jql: str, maxResults: { type: 'number' } }, ['jql']),
      run: (s, a) => {
        const who = /assignee\s*=\s*"([^"]+)"/.exec(a.jql ?? '')?.[1];
        return { issues: s.issues.filter((i) => !who || i.fields.assignee.emailAddress === who) };
      },
    },
    getJiraIssue: { schema: obj({ cloudId: str, issueIdOrKey: str }, ['issueIdOrKey']), run: (s, a) => s.issues.find((i) => i.key === a.issueIdOrKey) ?? { key: a.issueIdOrKey, fields: { summary: `Demo ticket ${a.issueIdOrKey}`, status: { name: 'In Progress' } } } },
    editJiraIssue: { schema: obj({ cloudId: str, issueIdOrKey: str, fields: { type: 'object' } }), run: () => ({ ok: true }) },
    addCommentToJiraIssue: { schema: obj({ cloudId: str, issueIdOrKey: str, commentBody: str }), run: () => ({ ok: true }) },
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
    setConfluencePageRestrictions: { schema: obj({ cloudId: str, pageId: str, users: { type: 'array', items: str } }), run: () => ({ ok: true }) },
    searchConfluenceUsingCql: { schema: obj({ cloudId: str, cql: str }), run: () => ({ results: [] }) },
  },
};

const tools = TOOLS[kind];
if (!tools) {
  process.stderr.write(`unknown demo server ${kind}\n`);
  process.exit(2);
}
const server = new Server({ name: `demo-${kind}`, version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(tools).map(([name, t]) => ({ name, description: `Demo ${kind}: ${name}`, inputSchema: t.schema, annotations: { readOnlyHint: !/create|update|edit|add|set/i.test(name) } })),
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
