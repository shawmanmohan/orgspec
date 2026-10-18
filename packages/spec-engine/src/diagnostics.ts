export type Severity = 'error' | 'warning' | 'info';

/** One machine-readable finding, shared by every command. */
export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  path?: string;
  line?: number;
  fix?: string;
}

type Extra = Omit<Diagnostic, 'severity' | 'code' | 'message'>;

export const error = (code: string, message: string, extra: Extra = {}): Diagnostic => ({
  severity: 'error',
  code,
  message,
  ...extra,
});

export const warning = (code: string, message: string, extra: Extra = {}): Diagnostic => ({
  severity: 'warning',
  code,
  message,
  ...extra,
});

export const hasErrors = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((d) => d.severity === 'error');

/** In strict mode every warning counts as an error. */
export const applyStrict = (diagnostics: readonly Diagnostic[], strict: boolean): Diagnostic[] =>
  strict
    ? diagnostics.map((d) => (d.severity === 'warning' ? { ...d, severity: 'error' as const } : d))
    : [...diagnostics];

export class OrgSpecError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '));
    this.name = 'OrgSpecError';
    this.diagnostics = diagnostics;
  }
}
