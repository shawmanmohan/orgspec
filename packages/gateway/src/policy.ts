import type { McpGrant } from '@orgspec/core';
import { matchesAny } from '@orgspec/core';
import { loadCedarModule } from './cedar-load.js';

type CedarValue =
  | boolean
  | number
  | string
  | CedarValue[]
  | { [k: string]: CedarValue }
  | { __entity: { type: string; id: string } };
interface Cedar {
  isAuthorized(call: {
    principal: { type: string; id: string };
    action: { type: string; id: string };
    resource: { type: string; id: string };
    context: Record<string, CedarValue>;
    policies: { staticPolicies: string };
    entities: {
      uid: { type: string; id: string };
      attrs: Record<string, CedarValue>;
      parents: { type: string; id: string }[];
    }[];
  }):
    | {
        type: 'success';
        response: { decision: 'allow' | 'deny'; diagnostics: { reason: string[]; errors: unknown[] } };
      }
    | { type: 'failure'; errors: { message: string }[] };
  checkParsePolicySet(p: {
    staticPolicies: string;
  }): { type: 'success' } | { type: 'failure'; errors: { message: string }[] };
}

let cedar: Cedar | undefined;
const loadCedar = (): Cedar => {
  cedar ??= loadCedarModule() as Cedar;
  return cedar;
};

const lit = (s: string) => JSON.stringify(s);

/** Turns a glob over tool names into a Cedar `like` pattern (`get*` stays `get*`; literal `*` cannot appear in MCP tool names). */
const likePattern = (glob: string) => lit(glob).replace(/\\\\/g, '\\\\');

/**
 * Cedar policies generated from a persona's MCP grants. Admin policies (forbid rules) from
 * `orgspec-config/policies/*.cedar` are appended and always win.
 */
export function grantPolicies(persona: string, grants: readonly McpGrant[]): string {
  const out: string[] = [];
  for (const g of grants) {
    const names = g.tools.map((t) => `resource.name like ${likePattern(t)}`).join(' || ');
    out.push(
      `@id(${lit(`grant:${persona}:${g.server}`)})\npermit(principal == OrgSpec::Persona::${lit(persona)}, action == OrgSpec::Action::"call", resource is OrgSpec::Tool)\nwhen { resource.server == ${lit(g.server)} && (${names}) };`,
    );
  }
  out.push(
    `@id("local-tools")\npermit(principal, action == OrgSpec::Action::"call", resource is OrgSpec::Tool) when { resource.server == "orgspec" };`,
  );
  return out.join('\n\n');
}

export interface PolicyRequest {
  persona: string;
  server: string;
  tool: string;
  ticket?: string;
  readOnly: boolean;
}

export interface PolicyDecision {
  decision: 'allow' | 'deny' | 'confirm';
  reasons: string[];
  errors: string[];
}

/** Tools that send messages or publish always need a person's confirmation. */
export const ALWAYS_CONFIRM = /(^|_)(chat_post|post_message|send|publish|delete|remove|transition|merge)/i;

export class PolicyEngine {
  readonly policies: string;
  constructor(
    private readonly persona: string,
    private readonly grants: readonly McpGrant[],
    adminPolicies = '',
  ) {
    this.policies = `${grantPolicies(persona, grants)}\n\n${adminPolicies}`.trim();
    const check = loadCedar().checkParsePolicySet({ staticPolicies: this.policies });
    if (check.type === 'failure')
      throw new Error(`Invalid Cedar policy: ${check.errors.map((e) => e.message).join('; ')}`);
  }

  decide(req: PolicyRequest): PolicyDecision {
    const uid = { type: 'OrgSpec::Tool', id: `${req.server}__${req.tool}` };
    const answer = loadCedar().isAuthorized({
      principal: { type: 'OrgSpec::Persona', id: req.persona },
      action: { type: 'OrgSpec::Action', id: 'call' },
      resource: uid,
      context: { readOnly: req.readOnly, ticket: req.ticket ?? '' },
      policies: { staticPolicies: this.policies },
      entities: [
        { uid, attrs: { server: req.server, name: req.tool, readOnly: req.readOnly }, parents: [] },
        { uid: { type: 'OrgSpec::Persona', id: req.persona }, attrs: {}, parents: [] },
      ],
    });
    if (answer.type === 'failure')
      return { decision: 'deny', reasons: [], errors: answer.errors.map((e) => e.message) };
    const { decision, diagnostics } = answer.response;
    const errors = diagnostics.errors.map((e) => JSON.stringify(e));
    if (decision === 'deny') return { decision: 'deny', reasons: diagnostics.reason, errors };
    const grant = this.grants.find((g) => g.server === req.server);
    const confirm =
      req.server !== 'orgspec' &&
      (ALWAYS_CONFIRM.test(req.tool) || (grant ? matchesAny(req.tool, grant.confirm) : false));
    return { decision: confirm ? 'confirm' : 'allow', reasons: diagnostics.reason, errors };
  }
}
