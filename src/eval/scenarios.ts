import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ClinicalFields } from '../extraction/clinicalFields.js';
import type { ToolCall } from '../llm/types.js';
import type { ScriptedStepReply } from '../llm/mockClient.js';

/**
 * Scenario + ground-truth loading. Ground truth references canonical ClinicalFields
 * names only. SYNTHETIC DATA ONLY.
 */

export const ScenarioExpectation = z.object({
  extractions: ClinicalFields.partial().default({}),
  escalations: z.array(z.string()).default([]),
  required_steps_completed: z.array(z.string()).default([]),
  outcome: z.enum(['completed', 'partial', 'refused', 'escalated']).default('completed'),
});

export const Scenario = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string().min(3),
  discharge_doc: z.string().min(1),
  patient: z
    .object({
      externalRef: z.string().min(1),
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      phone: z.string().min(7),
    })
    .default({ externalRef: 'SYN-0001', firstName: 'Jordan', lastName: 'Ellis', dob: '1968-04-12', phone: '+15550001001' }),
  patient_turns: z.array(z.string()).min(1),
  /**
   * Which scripted step should emit `end_call` in mock mode. Refusals end early; use
   * "none" when the call is expected to run out of turns instead.
   */
  mock_end_call_at: z.string().default('wrap_up'),
  expected: ScenarioExpectation,
  notes: z.string().default(''),
});
export type Scenario = z.output<typeof Scenario>;

export class ScenarioError extends Error {
  readonly issues: string[];
  constructor(source: string, issues: string[]) {
    super(`Invalid scenario (${source}): ${issues.join('; ')}`);
    this.name = 'ScenarioError';
    this.issues = issues;
  }
}

export function loadScenarioFile(filePath: string): Scenario {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) throw new ScenarioError(absolute, ['file not found']);
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new ScenarioError(path.basename(absolute), [
      `YAML syntax error: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const parsed = Scenario.safeParse(raw);
  if (!parsed.success) {
    throw new ScenarioError(
      path.basename(absolute),
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  return parsed.data;
}

export function loadScenarios(dir = path.join(process.cwd(), 'evals', 'scenarios')): Scenario[] {
  if (!existsSync(dir)) throw new ScenarioError(dir, ['scenarios directory missing']);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
    .sort()
    .map((file) => loadScenarioFile(path.join(dir, file)));
}

/** A future ISO datetime used for mock follow-up scheduling. */
function futureIso(days = 2): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  date.setUTCHours(14, 0, 0, 0);
  return date.toISOString();
}

const SOB_SEVERITY: Record<string, number> = { mild: 3, moderate: 6, severe: 9 };

/**
 * Turn ground truth into the tool calls a *perfect* model would emit.
 *
 * This is what makes `--mock` meaningful: it exercises orchestration, escalation,
 * persistence and metric math end to end. It does NOT measure model quality — the mock
 * is handed the answers — so mock numbers never ship as results (see BUILD_REPORT).
 */
export function deriveMockToolCalls(expected: z.output<typeof ScenarioExpectation>): {
  identity: ToolCall[];
  symptoms: ToolCall[];
  medication: ToolCall[];
  wrapUp: ToolCall[];
} {
  const identity: ToolCall[] = [];
  const symptoms: ToolCall[] = [];
  const medication: ToolCall[] = [];
  const wrapUp: ToolCall[] = [];
  let index = 0;
  const id = (name: string): string => `${name}-mock-${(index += 1)}`;

  const f = expected.extractions as Record<string, unknown>;
  if (f.identity_verified !== undefined) {
    identity.push({
      id: id('identity'),
      name: 'record_identity_verification',
      arguments: { verified: f.identity_verified === true, method: 'dob' },
    });
  }
  if (typeof f.pain_score === 'number') {
    symptoms.push({
      id: id('pain'),
      name: 'record_symptom',
      arguments: { symptom: 'pain', severity: f.pain_score, onset: 'today', presence: f.pain_score > 0 },
    });
  }
  if (typeof f.fever_f === 'number') {
    symptoms.push({ id: id('vital'), name: 'record_vital', arguments: { name: 'temperature_f', value: f.fever_f } });
  }
  if (typeof f.shortness_of_breath === 'string') {
    const presence = f.shortness_of_breath !== 'none';
    symptoms.push({
      id: id('sob'),
      name: 'record_symptom',
      arguments: {
        symptom: 'shortness_of_breath',
        severity: SOB_SEVERITY[f.shortness_of_breath] ?? 9,
        onset: 'today',
        presence,
      },
    });
  }
  if (typeof f.chest_pain === 'boolean') {
    symptoms.push({
      id: id('chest'),
      name: 'record_symptom',
      arguments: { symptom: 'chest_pain', severity: f.chest_pain ? 6 : 1, onset: 'today', presence: f.chest_pain },
    });
  }
  if (typeof f.wound_concern === 'boolean') {
    symptoms.push({
      id: id('wound'),
      name: 'record_symptom',
      arguments: { symptom: 'wound', severity: f.wound_concern ? 5 : 1, onset: 'today', presence: f.wound_concern },
    });
  }
  const issues = Array.isArray(f.medication_issues) ? f.medication_issues.join('; ') : undefined;
  if (typeof f.medication_adherent === 'boolean' || issues !== undefined) {
    medication.push({
      id: id('meds'),
      name: 'record_medication_adherence',
      arguments: {
        medication: 'discharge medication',
        taken: f.medication_adherent !== false,
        ...(issues ? { issues } : {}),
      },
    });
  }
  if (f.followup_confirmed === true) {
    wrapUp.push({
      id: id('callback'),
      name: 'schedule_followup_callback',
      arguments: { iso_datetime: futureIso(), reason: 'post-discharge check-in' },
    });
  }
  return { identity, symptoms, medication, wrapUp };
}

/** Scripted agent replies for mock mode, keyed to the shipped call script's steps. */
export function mockScriptFor(scenario: Scenario): ScriptedStepReply[] {
  const calls = deriveMockToolCalls(scenario.expected);
  const identityOk = (scenario.expected.extractions.identity_verified ?? true) === true;
  const turns = scenario.patient_turns;
  const turn = (index: number, fallback: string): string => turns[index] ?? fallback;
  const endCall: ToolCall[] =
    scenario.mock_end_call_at === 'none'
      ? []
      : [{ id: 'end-mock', name: 'end_call', arguments: { outcome: scenario.expected.outcome } }];
  const endsAt = (stepId: string): ToolCall[] => (scenario.mock_end_call_at === stepId ? endCall : []);

  return [
    { stepId: 'greeting', utterance: 'Hello, this is the follow-up call from the clinic.', stepComplete: true },
    {
      stepId: 'identity_verification',
      utterance: 'Could you confirm your date of birth for me?',
      toolCalls: calls.identity,
      stepComplete: identityOk,
    },
    {
      stepId: 'symptom_check',
      utterance: turn(1, 'How are you feeling today?'),
      toolCalls: [...calls.symptoms, ...endsAt('symptom_check')],
      stepComplete: calls.symptoms.length > 0,
    },
    {
      stepId: 'medication_review',
      utterance: turn(3, 'Have you managed your medications?'),
      toolCalls: [...calls.medication, ...endsAt('medication_review')],
      stepComplete: calls.medication.length > 0,
    },
    {
      stepId: 'wrap_up',
      utterance: turn(4, 'Thanks — a nurse will follow up. Take care.'),
      toolCalls: [...calls.wrapUp, ...endsAt('wrap_up')],
      stepComplete: true,
    },
  ];
}

