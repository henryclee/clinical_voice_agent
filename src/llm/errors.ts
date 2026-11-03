/** Typed error surface so callers can branch on failure mode instead of parsing strings. */

export class LlmCallError extends Error {
  readonly status?: number;
  readonly attempts: number;
  readonly retryable: boolean;
  constructor(message: string, options: { status?: number; attempts: number; retryable: boolean }) {
    super(message);
    this.name = 'LlmCallError';
    this.status = options.status;
    this.attempts = options.attempts;
    this.retryable = options.retryable;
  }
}

export class ExtractionError extends Error {
  readonly issues: string[];
  readonly raw?: unknown;
  constructor(message: string, issues: string[] = [], raw?: unknown) {
    super(message);
    this.name = 'ExtractionError';
    this.issues = issues;
    this.raw = raw;
  }
}

/** Local endpoints sometimes reject optional params (response_format / tools). */
export function unsupportedParameterName(errorMessage: string): 'response_format' | 'tools' | null {
  const lower = errorMessage.toLowerCase();
  if (lower.includes('response_format') || lower.includes('response format')) return 'response_format';
  if (lower.includes('tool')) return 'tools';
  return null;
}

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    return name === 'aborterror' || name === 'timeouterror' || /timeout|timed out|abort/i.test(error.message);
  }
  return false;
}

export function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  }
  return undefined;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
