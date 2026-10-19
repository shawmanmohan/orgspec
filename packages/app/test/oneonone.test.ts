import { memoryConnector } from '@orgspec/gateway';
import { describe, expect, it } from 'vitest';
import {
  addAction,
  completeAction,
  findReport,
  freeSlots,
  groundBrief,
  listActions,
  roster,
  sectionItems,
} from '../src/index.js';
import { makeContext, orgConfig } from './helpers.js';

describe('free slots', () => {
  it('finds common free time on different weekdays, avoiding busy blocks and lunch', () => {
    const from = new Date('2026-10-19T08:00:00'); // Monday
    const busy = {
      'me@x': [
        { start: new Date('2026-10-20T10:00:00').toISOString(), end: new Date('2026-10-20T11:00:00').toISOString() },
      ],
      'r@x': [],
    };
    const slots = freeSlots(busy, {
      from,
      minutes: 30,
      workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
    });
    expect(slots).toHaveLength(3);
    expect(new Date(slots[0]?.start ?? '').getHours()).toBe(11); // Tue 10:00 is busy
    expect(new Set(slots.map((s) => new Date(s.start).getDay())).size).toBe(3);
  });
});

describe('briefs', () => {
  it('drops strengths and growth areas without a known source', () => {
    const { brief, dropped } = groundBrief(
      {
        workSince: 'x',
        strengths: [
          { text: 'a', source: 'PROJ-1' },
          { text: 'b', source: 'gossip' },
        ],
        growth: [{ text: 'c', source: 'agenda' }],
        goals: [],
        questions: [],
      },
      ['PROJ-1', 'agenda'],
    );
    expect(brief.strengths.map((s) => s.text)).toEqual(['a']);
    expect(brief.growth).toHaveLength(1);
    expect(dropped).toBe(1);
  });
  it('reads agenda, goals and context sections from the shared page', () => {
    const page =
      '<h2>Agenda</h2><ul><li>On-call <em>· Asha</em></li></ul><h2>Goals</h2><ul><li>Lead a design</li></ul><h2>Context from Asha</h2><p>Was on call.</p>';
    expect(sectionItems(page, /^agenda$/i)).toEqual(['On-call · Asha']);
    expect(sectionItems(page, /^goals$/i)).toEqual(['Lead a design']);
    expect(sectionItems(page, /^context from/i)).toEqual(['Was on call.']);
  });
});

describe('roster', () => {
  it('lists only HR reports with next 1:1 and encrypted agreed actions', async () => {
    const { dir } = orgConfig(undefined, {
      'integrations.yaml':
        'servers:\n  hr: { transport: stdio, command: x }\n  calendar: { transport: stdio, command: x }\n',
    });
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const connector = memoryConnector({
      hr: { tools: [], handle: () => ({ reports: [{ email: 'asha@x', name: 'Asha Rao', title: 'Senior engineer' }] }) },
      calendar: {
        tools: [],
        handle: () => ({
          events: [{ id: 'e1', title: '1:1 Asha / me', start: soon, end: soon, attendees: ['me@x', 'asha@x'] }],
        }),
      },
    });
    const ctx = makeContext({ configDir: dir, connector, settings: { identity: { email: 'me@x' } } });
    const [asha] = await roster(ctx);
    expect(asha).toMatchObject({ email: 'asha@x', openActions: 0, nextOneOnOne: { id: 'e1' } });
    await expect(findReport(ctx, 'someone@else')).rejects.toThrow('not one of your direct reports');
    const id = await addAction(ctx, asha as NonNullable<typeof asha>, 'Share design review examples');
    expect((await listActions(ctx, 'asha@x'))[0]?.text).toBe('Share design review examples');
    const raw = ctx.privateDb().prepare('select payload from oneonone_actions').get() as { payload: string };
    expect(raw.payload).not.toContain('design');
    completeAction(ctx, id);
    expect(await listActions(ctx, 'asha@x')).toEqual([]);
  });
});
