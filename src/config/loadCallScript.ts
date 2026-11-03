import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { CallScript, deriveRequiredSteps, type CallScriptStep } from './schema.js';
import { INTERPOLATION_WHITELIST } from './interpolate.js';

export class CallScriptError extends Error {
  readonly origin: string;
  readonly issues: string[];
  constructor(origin: string, issues: string[]) {
    super(`Invalid call script (${origin}):\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'CallScriptError';
    this.origin = origin;
    this.issues = issues;
  }
}

export interface LoadedCallScript {
  script: CallScript;
  requiredSteps: string[];
  steps: CallScriptStep[];
  source: string;
  path: string;
}

const DEFAULT_SCRIPT_PATH = path.join('call_scripts', 'post_discharge_followup.yaml');

/** Parse + validate YAML source. Throws {@link CallScriptError} with readable issues. */
export function parseCallScript(source: string, origin = '<string>'): LoadedCallScript {
  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (error) {
    throw new CallScriptError(origin, [`YAML syntax error: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const parsed = CallScript.safeParse(raw);
  if (!parsed.success) {
    throw new CallScriptError(
      origin,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    );
  }
  return {
    script: parsed.data,
    requiredSteps: deriveRequiredSteps(parsed.data),
    steps: parsed.data.steps,
    source,
    path: origin,
  };
}

export function loadCallScript(filePath: string): LoadedCallScript {
  const absolute = path.resolve(filePath);
  let source: string;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new CallScriptError(absolute, [`could not read file: ${error instanceof Error ? error.message : String(error)}`]);
  }
  return parseCallScript(source, absolute);
}

export function loadDefaultCallScript(cwd: string = process.cwd()): LoadedCallScript {
  return loadCallScript(path.join(cwd, DEFAULT_SCRIPT_PATH));
}

export { INTERPOLATION_WHITELIST };
