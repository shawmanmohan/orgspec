export * from './atlassian.js';
export * from './gh.js';
export * from './tools.js';
export * from './workplace.js';

import type { Integrations } from '@orgspec/core';
import { Confluence, Jira } from './atlassian.js';
import { Operations, type ToolCaller } from './tools.js';
import { Calendar, Ci, Hr, Slack } from './workplace.js';

/** All workplace systems behind one ToolCaller (the gateway's upstream pool). */
export function workplace(caller: ToolCaller, config?: Pick<Integrations, 'operations' | 'constants'>) {
  const ops = new Operations(caller, config);
  return {
    ops,
    jira: new Jira(ops),
    confluence: new Confluence(ops),
    slack: new Slack(ops),
    ci: new Ci(ops),
    hr: new Hr(ops),
    calendar: new Calendar(ops),
  };
}
export type Workplace = ReturnType<typeof workplace>;
