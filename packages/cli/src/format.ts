import type { Diagnostic } from '@orgspec/spec-engine';

const LABEL: Record<Diagnostic['severity'], string> = { error: 'error  ', warning: 'warning', info: 'info   ' };

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const where = d.path ? `  ${d.path}${d.line ? `:${d.line}` : ''}` : '';
      const fix = d.fix ? `\n           fix: ${d.fix}` : '';
      return `  ${LABEL[d.severity]}  ${d.code}${where}\n           ${d.message}${fix}`;
    })
    .join('\n');
}

export function summary(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  return `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
}
