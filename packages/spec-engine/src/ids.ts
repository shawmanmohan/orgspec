export const REQUIREMENT_HEADER = /^Requirement:\s*(.+?)\s*\{#([^}\s]+)\}\s*$/;
export const REQUIREMENT_HEADER_NO_ID = /^Requirement:\s*(.+?)\s*$/;
export const SCENARIO_HEADER = /^Scenario:\s*(.+?)\s*\{#([^}\s]+)\}\s*$/;
export const SCENARIO_HEADER_NO_ID = /^Scenario:\s*(.+?)\s*$/;

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isKebabSegment = (s: string): boolean => SEGMENT.test(s);

/** `payments/retries` → `payments.retries`. */
export function capabilityIdFromPath(capabilityPath: string): string {
  return capabilityPath.split(/[\\/]/).filter(Boolean).join('.');
}

export function capabilityPathFromId(capabilityId: string): string {
  return capabilityId.split('.').join('/');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A requirement ID is `<capability id>.<kebab slug>`, for example `payments.retries.capture`. */
export function isValidRequirementId(capabilityId: string, id: string): boolean {
  if (!id.startsWith(`${capabilityId}.`)) return false;
  const rest = id.slice(capabilityId.length + 1);
  return rest.length > 0 && rest.split('.').every(isKebabSegment);
}

/** A scenario ID is `<requirement id>/<kebab slug>`. */
export function isValidScenarioId(requirementId: string, id: string): boolean {
  if (!id.startsWith(`${requirementId}/`)) return false;
  return isKebabSegment(id.slice(requirementId.length + 1));
}

export const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
export const CHANGE_ID = /^[A-Z][A-Z0-9]+-\d+(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
