/**
 * `{{var}}` interpolation with an explicit whitelist. An unknown placeholder is a
 * *script authoring error* and must fail at load time rather than reaching a patient's
 * phone as literal "{{practice_name}}".
 */
export const INTERPOLATION_WHITELIST = ['practice_name'] as const;

export type InterpolationKey = (typeof INTERPOLATION_WHITELIST)[number];
export type InterpolationVars = Partial<Record<InterpolationKey, string>>;

export class InterpolationError extends Error {
  readonly unknownVars: string[];
  constructor(message: string, unknownVars: string[] = []) {
    super(message);
    this.name = 'InterpolationError';
    this.unknownVars = unknownVars;
  }
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function findPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match[1]) out.add(match[1]);
  }
  return [...out];
}

export function assertKnownPlaceholders(texts: string[], context: string): void {
  const unknown = new Set<string>();
  for (const text of texts) {
    for (const name of findPlaceholders(text)) {
      if (!(INTERPOLATION_WHITELIST as readonly string[]).includes(name)) unknown.add(name);
    }
  }
  if (unknown.size > 0) {
    throw new InterpolationError(
      `${context}: unknown placeholder(s) {${[...unknown].join(', ')}}. Allowed: ${INTERPOLATION_WHITELIST.join(', ')}`,
      [...unknown],
    );
  }
}

export function interpolate(text: string, vars: InterpolationVars, context = 'call script'): string {
  const unknown = findPlaceholders(text).filter(
    (name) => !(INTERPOLATION_WHITELIST as readonly string[]).includes(name),
  );
  if (unknown.length > 0) {
    throw new InterpolationError(
      `${context}: unknown placeholder(s) {${unknown.join(', ')}}. Allowed: ${INTERPOLATION_WHITELIST.join(', ')}`,
      unknown,
    );
  }
  return text.replace(PLACEHOLDER, (_full, name: string) => {
    const value = vars[name as InterpolationKey];
    if (value === undefined || value === '') {
      throw new InterpolationError(`${context}: no value supplied for placeholder {{${name}}}`, [name]);
    }
    return value;
  });
}
