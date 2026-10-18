import { LAYERS, type Layer, matchesAny, type Waiver } from '@orgspec/core';
import { type Diagnostic, error, warning } from '@orgspec/spec-engine';
import { type Check, ENFORCEMENT_RANK, type Rule, SEVERITY_RANK, TIER_RANK } from './rules.js';

const superset = (a: readonly string[], b: readonly string[]): boolean => b.every((x) => a.includes(x));

/** Why `lower` is looser than `upper`, or undefined when it is the same or tighter. */
export function loosening(upper: Rule, lower: Rule): string | undefined {
  if (ENFORCEMENT_RANK[lower.enforcement] < ENFORCEMENT_RANK[upper.enforcement]) {
    return `enforcement ${lower.enforcement} is weaker than ${upper.enforcement}`;
  }
  if (SEVERITY_RANK[lower.severity] < SEVERITY_RANK[upper.severity]) {
    return `severity ${lower.severity} is weaker than ${upper.severity}`;
  }
  if (!superset(lower.appliesTo.tiers, upper.appliesTo.tiers)) return 'applies to fewer tiers';
  const upperAll = upper.appliesTo.personas.length === 0;
  if (upperAll ? lower.appliesTo.personas.length > 0 : !superset(lower.appliesTo.personas, upper.appliesTo.personas)) {
    return 'applies to fewer personas';
  }
  if (upper.check && !lower.check) return 'drops the check';
  if (upper.check && lower.check) return checkLoosening(upper.check, lower.check);
  return undefined;
}

function checkLoosening(u: Check, l: Check): string | undefined {
  if (u.kind !== l.kind) return `changes the check from ${u.kind} to ${l.kind}`;
  switch (u.kind) {
    case 'artifact-required': {
      const lc = l as typeof u;
      if (!superset(lc.artifacts, u.artifacts)) return 'requires fewer artifacts';
      if (!superset(lc.tiers, u.tiers)) return 'requires artifacts at fewer tiers';
      return undefined;
    }
    case 'section-required': {
      const lc = l as typeof u;
      return lc.artifact === u.artifact && lc.heading === u.heading ? undefined : 'requires a different section';
    }
    case 'path-rule': {
      const lc = l as typeof u;
      if (!superset(lc.paths, u.paths)) return 'covers fewer paths';
      return TIER_RANK[lc.minTier] < TIER_RANK[u.minTier] ? `lowers the tier floor to ${lc.minTier}` : undefined;
    }
    case 'approval': {
      const lc = l as typeof u;
      if (lc.artifact !== u.artifact) return 'approves a different artifact';
      if ((u.role && lc.role !== u.role) || (u.team && lc.team !== u.team)) return 'changes who approves';
      return lc.count < u.count ? `needs ${lc.count} approval(s) instead of ${u.count}` : undefined;
    }
    case 'trace-coverage':
      return superset((l as typeof u).tiers, u.tiers) ? undefined : 'checks coverage at fewer tiers';
    case 'git-op': {
      const lc = l as typeof u;
      if (!superset(lc.deny, u.deny)) return 'denies fewer git operations';
      if (!superset([...lc.ask, ...lc.deny], u.ask)) return 'asks about fewer git operations';
      return superset(lc.tiers, u.tiers) ? undefined : 'applies to fewer tiers';
    }
    case 'file-scope': {
      const lc = l as typeof u;
      if (!superset(lc.deny, u.deny)) return 'protects fewer paths';
      if (lc.allowWhenNamedInSpec && !u.allowWhenNamedInSpec) return 'allows exceptions the upper layer does not';
      return superset(lc.tiers, u.tiers) ? undefined : 'applies to fewer tiers';
    }
    case 'pattern-forbid': {
      const lc = l as typeof u;
      return lc.pattern === u.pattern && superset(lc.paths, u.paths)
        ? undefined
        : 'forbids the pattern in fewer places';
    }
    case 'rubric':
      return undefined;
  }
}

export interface LayerRules {
  layer: Layer;
  scope?: string;
  rules: Rule[];
}

/**
 * Checks every scoped or persona override against the base layer and returns the full rule set,
 * keeping scoped variants so each repo can resolve its own effective rules.
 */
export function mergeLayers(layers: readonly LayerRules[]): { rules: Rule[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const ordered = [...layers].sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer));
  const upperById = new Map<string, Rule>();
  const out: Rule[] = [];

  for (const l of ordered) {
    for (const r of l.rules) {
      const rule: Rule = { ...r, layer: l.layer, ...(l.scope ? { scope: l.scope } : {}) };
      const upper = upperById.get(rule.id);
      if (upper) {
        const why = loosening(upper, rule);
        if (why) {
          diagnostics.push(
            error('layer_loosens_rule', `${l.layer}${l.scope ? ` ${l.scope}` : ''} loosens ${rule.id}: ${why}`, {
              fix: `Match or tighten the ${upper.layer} rule, or file a time-limited waiver in waivers/`,
            }),
          );
          continue;
        }
      }
      if (l.layer === 'base') upperById.set(rule.id, rule);
      out.push(rule);
    }
  }
  const seen = new Set<string>();
  for (const r of out) {
    const key = `${r.layer}:${r.scope ?? ''}:${r.id}`;
    if (seen.has(key)) diagnostics.push(warning('rule_duplicate', `${r.id} is defined twice in the ${r.layer} layer`));
    seen.add(key);
  }
  return { rules: out, diagnostics };
}

export interface ResolveContext {
  persona: string;
  department?: string;
  team?: string;
  repo?: string;
}

/** The effective rules for one repo and persona: the most specific variant of each rule ID wins. */
export function resolveRules(rules: readonly Rule[], ctx: ResolveContext): Rule[] {
  const matches = (r: Rule): boolean => {
    switch (r.layer) {
      case 'base':
      case 'persona':
        return true;
      case 'department':
        return r.scope === ctx.department;
      case 'team':
        return r.scope === ctx.team;
      case 'repo':
        return r.scope === ctx.repo;
    }
  };
  const byId = new Map<string, Rule>();
  const ordered = [...rules].sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer));
  for (const r of ordered) {
    if (!matches(r)) continue;
    if (r.appliesTo.personas.length > 0 && !r.appliesTo.personas.includes(ctx.persona)) continue;
    byId.set(r.id, r);
  }
  return [...byId.values()];
}

export interface WaiverContext {
  team?: string;
  repo?: string;
  change?: string;
  paths?: readonly string[];
  today?: string;
}

/** Rule IDs that an active waiver covers in this context. */
export function waivedRuleIds(waivers: readonly Waiver[], ctx: WaiverContext): Map<string, Waiver> {
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const out = new Map<string, Waiver>();
  for (const w of waivers) {
    if (w.expires < today) continue;
    const s = w.scope;
    if (s.team && s.team !== ctx.team) continue;
    if (s.repo && s.repo !== ctx.repo) continue;
    if (s.change && s.change !== ctx.change) continue;
    if (s.paths && !(ctx.paths ?? []).some((p) => matchesAny(p, s.paths ?? []))) continue;
    out.set(w.rule, w);
  }
  return out;
}
