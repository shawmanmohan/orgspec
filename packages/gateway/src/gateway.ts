import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendAudit, type Db, type McpGrant, matchesAny, nowIso } from '@orgspec/core';
import type { ToolResult } from '@orgspec/integrations';
import { egressViolations, summarizeCall, wrapUntrusted } from './content.js';
import { PolicyEngine } from './policy.js';
import { SEP, splitName, type UpstreamPool, type UpstreamTool } from './upstream.js';

export interface GatewaySession {
  id: string;
  persona: string;
  ticket?: string;
  tier?: string;
}

export interface GatewayOptions {
  session: GatewaySession;
  grants: McpGrant[];
  adminPolicies?: string;
  pool: UpstreamPool;
  db: Db;
  egressAllow: string[];
  /** Search over indexed decision records (FTS). */
  searchDecisions?: (
    query: string,
    limit: number,
  ) => { adrId: string; repo: string; title: string; status: string; file: string; snippet: string }[];
}

const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError } : {}),
});

export interface PendingAction {
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  persona?: string;
  ticket?: string;
  state: 'pending' | 'approved' | 'rejected' | 'done' | 'failed';
  createdAt: string;
  decidedAt?: string;
  result?: string;
}

/** Pending confirmations, stored in the local cache DB and approved from the dashboard or CLI. */
export const pendingActions = (db: Db) => ({
  create(a: Omit<PendingAction, 'id' | 'state' | 'createdAt'>): PendingAction {
    const row: PendingAction = { ...a, id: `act_${randomUUID().slice(0, 8)}`, state: 'pending', createdAt: nowIso() };
    db.prepare(
      'insert into pending_actions (id, server, tool, args, summary, persona, ticket, state, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      row.id,
      row.server,
      row.tool,
      JSON.stringify(row.args),
      row.summary,
      row.persona ?? null,
      row.ticket ?? null,
      row.state,
      row.createdAt,
    );
    return row;
  },
  get(id: string): PendingAction | undefined {
    const r = db.prepare('select * from pending_actions where id = ?').get(id) as
      | Record<string, string | null>
      | undefined;
    return r ? toAction(r) : undefined;
  },
  list(state?: PendingAction['state']): PendingAction[] {
    const rows = (
      state
        ? db.prepare('select * from pending_actions where state = ? order by created_at desc').all(state)
        : db.prepare('select * from pending_actions order by created_at desc limit 200').all()
    ) as Record<string, string | null>[];
    return rows.map(toAction);
  },
  decide(id: string, approve: boolean): void {
    db.prepare("update pending_actions set state = ?, decided_at = ? where id = ? and state = 'pending'").run(
      approve ? 'approved' : 'rejected',
      nowIso(),
      id,
    );
  },
  finish(id: string, ok: boolean, result: string): void {
    db.prepare('update pending_actions set state = ?, result = ? where id = ?').run(
      ok ? 'done' : 'failed',
      result.slice(0, 20_000),
      id,
    );
  },
});

const toAction = (r: Record<string, string | null>): PendingAction => ({
  id: r.id as string,
  server: r.server as string,
  tool: r.tool as string,
  args: JSON.parse(r.args ?? '{}') as Record<string, unknown>,
  summary: r.summary as string,
  state: r.state as PendingAction['state'],
  createdAt: r.created_at as string,
  ...(r.persona ? { persona: r.persona } : {}),
  ...(r.ticket ? { ticket: r.ticket } : {}),
  ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
  ...(r.result ? { result: r.result } : {}),
});

const LOCAL_TOOLS: UpstreamTool[] = [
  {
    name: `orgspec${SEP}search_decisions`,
    description: 'Search the organisation’s decision records (ADRs) indexed from your repositories.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: `orgspec${SEP}run_pending`,
    description: 'Run an action after a person approved it in OrgSpec. Pass the action id you were given.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

/**
 * The only MCP server Claude Code loads. It proxies the persona's allowed upstream tools under
 * `server__tool` names, applies Cedar policy, asks for confirmation on writes, wraps results as
 * untrusted data, checks egress and writes a local audit entry for every call.
 */
export class Gateway {
  readonly server: Server;
  readonly policy: PolicyEngine;
  private readonly pending;

  constructor(private readonly o: GatewayOptions) {
    this.policy = new PolicyEngine(o.session.persona, o.grants, o.adminPolicies);
    this.pending = pendingActions(o.db);
    this.server = new Server(
      { name: 'orgspec', version: '0.1.0' },
      { capabilities: { tools: { listChanged: false } } },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.listTools() }));
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (req) => this.callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>) as never,
    );
  }

  private readOnly(t: UpstreamTool | undefined, tool: string): boolean {
    if (t?.annotations?.readOnlyHint !== undefined) return t.annotations.readOnlyHint;
    return (
      /^(get|list|search|read|fetch|lookup|query|describe)/i.test(tool.replace(/^.*?[_.]/, '')) ||
      /^(get|list|search|read|fetch|lookup|query|describe)/i.test(tool)
    );
  }

  /** Upstream tools the persona may call, plus OrgSpec's own. */
  async listTools(): Promise<UpstreamTool[]> {
    const granted = new Set(this.o.grants.map((g) => g.server));
    const { tools } = await this.o.pool.allTools();
    const visible = tools.filter(
      (t) =>
        granted.has(t.server) &&
        this.policy.decide({ ...this.req(t.server, t.upstreamName), readOnly: this.readOnly(t, t.upstreamName) })
          .decision !== 'deny',
    );
    return [...visible.map(({ server: _s, upstreamName: _u, ...t }) => t), ...LOCAL_TOOLS];
  }

  private req(server: string, tool: string) {
    return {
      persona: this.o.session.persona,
      server,
      tool,
      ...(this.o.session.ticket ? { ticket: this.o.session.ticket } : {}),
    };
  }

  private audit(entry: Record<string, unknown>): void {
    appendAudit(this.o.db, {
      kind: 'mcp',
      session: this.o.session.id,
      persona: this.o.session.persona,
      ticket: this.o.session.ticket,
      ...entry,
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    let server: string;
    let tool: string;
    try {
      ({ server, tool } = splitName(name));
    } catch (e) {
      return textResult((e as Error).message, true);
    }
    if (server === 'orgspec') return this.local(tool, args);

    const t = (await this.o.pool.tools(server).catch(() => [])).find((x) => x.name === tool);
    const readOnly = this.readOnly(t, tool);
    const d = this.policy.decide({ ...this.req(server, tool), readOnly });
    if (d.decision === 'deny') {
      this.audit({ server, tool, decision: 'deny', reasons: d.reasons });
      return textResult(`OrgSpec policy does not allow ${name} for the ${this.o.session.persona} persona.`, true);
    }
    if (!readOnly) {
      const allow = [...this.o.egressAllow, ...(this.o.pool.config(server)?.hosts ?? [])];
      const bad = egressViolations(args, allow);
      if (bad.length) {
        this.audit({ server, tool, decision: 'egress-deny', hosts: bad });
        return textResult(`Blocked: the call links to ${bad.join(', ')}, which is not an allowed host.`, true);
      }
    }
    if (d.decision === 'confirm') {
      const summary = summarizeCall(server, tool, args);
      const approved = await this.elicit(summary);
      if (approved === false) {
        this.audit({ server, tool, decision: 'rejected' });
        return textResult('The person declined this action.', true);
      }
      if (approved === undefined) {
        const a = this.pending.create({
          server,
          tool,
          args,
          summary,
          persona: this.o.session.persona,
          ...(this.o.session.ticket ? { ticket: this.o.session.ticket } : {}),
        });
        this.audit({ server, tool, decision: 'pending', action: a.id });
        return textResult(
          `This action needs a person's approval. Ask them to approve ${a.id} in the OrgSpec dashboard or run \`orgspec actions approve ${a.id}\`, then call orgspec${SEP}run_pending with id "${a.id}".`,
        );
      }
    }
    return this.forward(server, tool, args, d.decision === 'confirm' ? 'confirmed' : 'allow');
  }

  private async forward(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    decision: string,
  ): Promise<ToolResult> {
    const started = Date.now();
    try {
      const res = await this.o.pool.callTool(`${server}${SEP}${tool}`, args);
      this.audit({ server, tool, decision, ok: !res.isError, ms: Date.now() - started });
      return this.o.pool.config(server)?.untrusted === false ? res : wrapUntrusted(res, `${server}${SEP}${tool}`);
    } catch (e) {
      this.audit({ server, tool, decision, ok: false, error: (e as Error).message });
      return textResult(`${server} is unavailable: ${(e as Error).message}`, true);
    }
  }

  /** Asks through MCP elicitation when the client supports it; undefined means it cannot ask. */
  private async elicit(summary: string): Promise<boolean | undefined> {
    if (!this.server.getClientCapabilities()?.elicitation) return undefined;
    try {
      const r = await this.server.elicitInput({
        mode: 'form',
        message: `OrgSpec: allow this action?\n\n${summary}`,
        requestedSchema: {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Approve', default: false } },
          required: ['approve'],
        },
      } as never);
      return r.action === 'accept' && (r.content as { approve?: boolean } | undefined)?.approve === true;
    } catch {
      return undefined;
    }
  }

  private async local(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (tool === 'search_decisions') {
      const q = String(args.query ?? '').trim();
      if (!q) return textResult('query is required', true);
      const hits = this.o.searchDecisions?.(q, Math.min(Number(args.limit ?? 10), 50)) ?? [];
      this.audit({ server: 'orgspec', tool, decision: 'allow', hits: hits.length });
      return textResult(hits.length ? JSON.stringify(hits, null, 2) : 'No decision records match.');
    }
    if (tool === 'run_pending') {
      const a = this.pending.get(String(args.id ?? ''));
      if (!a) return textResult('No such action.', true);
      if (a.persona && a.persona !== this.o.session.persona)
        return textResult('That action belongs to another persona.', true);
      if (a.state === 'pending') return textResult(`${a.id} is still waiting for approval.`);
      if (a.state !== 'approved') return textResult(`${a.id} is ${a.state}.`, a.state === 'rejected');
      const d = this.policy.decide({ ...this.req(a.server, a.tool), readOnly: false });
      if (d.decision === 'deny') return textResult('Policy no longer allows this action.', true);
      const res = await this.forward(a.server, a.tool, a.args, 'approved');
      this.pending.finish(a.id, !res.isError, JSON.stringify(res.content ?? []));
      return res;
    }
    return textResult(`Unknown OrgSpec tool ${tool}`, true);
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /** Serves over stdin/stdout (how Claude Code starts the gateway). */
  async connectStdio(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.o.pool.close();
  }
}

export const isGranted = (grants: readonly McpGrant[], server: string, tool: string) =>
  grants.some((g) => g.server === server && matchesAny(tool, g.tools));
