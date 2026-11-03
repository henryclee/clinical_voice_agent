import type { CallScript } from '../config/schema.js';
import { interpolate } from '../config/interpolate.js';
import type { ClinicalFields } from '../extraction/clinicalFields.js';
import type { ChatMessage } from '../llm/types.js';
import type { CallStateMachine, StepFailureAction } from './stateMachine.js';

/**
 * Prompt assembly. Everything the model knows comes from here — patient context, the
 * single active step, and the rules it must not break. The model never sees a "next
 * step" choice: the state machine owns the cursor.
 */

export interface DischargeContext {
  primaryDiagnosis: string;
  procedures: string[];
  medications: Array<{ name: string; dose: string; frequency: string }>;
  followUp: { provider: string; within_days?: number | undefined; reason: string };
  redFlags: string[];
  dischargeDate?: string;
}

export interface PatientContext {
  firstName: string;
  lastName: string;
  dob: string;
  externalRef: string;
  discharge: DischargeContext;
}

export interface PromptInput {
  script: CallScript;
  practiceName: string;
  patient: PatientContext;
  machine: CallStateMachine;
  fields: ClinicalFields;
  transcript: ChatMessage[];
  patientUtterance: string;
  failure?: StepFailureAction;
}

/** Deterministic evidence check: which canonical fields prove a step satisfied. */
export function stepSatisfied(stepId: string, fields: ClinicalFields): boolean {
  switch (stepId) {
    case 'greeting':
      return true;
    case 'identity_verification':
      return fields.identity_verified === true;
    case 'symptom_check':
      return (
        fields.pain_score !== undefined ||
        fields.fever_f !== undefined ||
        fields.shortness_of_breath !== undefined ||
        fields.chest_pain === true ||
        fields.wound_concern === true
      );
    case 'medication_review':
      return fields.medication_adherent !== undefined;
    case 'wrap_up':
      return fields.followup_confirmed === true || fields.next_steps.length > 0;
    default:
      // Unknown step ids have no canonical evidence; the model must assert completion.
      return false;
  }
}

function statusGlyph(state: string): string {
  switch (state) {
    case 'done':
      return 'DONE';
    case 'active':
      return 'NOW';
    case 'failed':
      return 'FAILED';
    case 'flagged':
      return 'FLAGGED';
    default:
      return 'later';
  }
}

export function buildSystemPrompt(input: PromptInput): string {
  const { script, practiceName, patient, machine, fields } = input;
  const persona = interpolate(script.persona, { practice_name: practiceName }, 'persona');
  const current = machine.current();
  const stepLines = machine.steps.map(
    (step) => `  - [${statusGlyph(step.state)}] ${step.id}${step.required ? '' : ' (optional)'}`,
  );
  const redFlags = script.escalation_rules.map((rule) => `  - ${rule.id}: ${rule.reason} (${rule.urgency})`);
  const hint = failureHint(input.failure);

  return [
    persona.trim(),
    '',
    `Organisation: ${practiceName}`,
    `Call script: ${script.id} v${script.version}`,
    '',
    'PATIENT (synthetic data — never a real person):',
    `  name: ${patient.firstName} ${patient.lastName}`,
    `  dob: ${patient.dob}`,
    `  ref: ${patient.externalRef}`,
    `  discharge date: ${patient.discharge.dischargeDate ?? 'unknown'}`,
    `  diagnosis: ${patient.discharge.primaryDiagnosis}`,
    `  procedures: ${patient.discharge.procedures.join('; ') || 'none'}`,
    `  discharge meds: ${
      patient.discharge.medications
        .map((med) => [med.name, med.dose, med.frequency].filter(Boolean).join(' '))
        .join('; ') || 'none'
    }`,
    `  follow-up: ${
      [
        patient.discharge.followUp.provider,
        patient.discharge.followUp.within_days ? `within ${patient.discharge.followUp.within_days} days` : '',
        patient.discharge.followUp.reason,
      ]
        .filter(Boolean)
        .join(' — ') || 'none'
    }`,
    `  red flags the patient was told to watch for: ${patient.discharge.redFlags.join('; ') || 'none'}`,
    '',
    'STEPS (you never choose the order; the system advances the cursor):',
    ...stepLines,
    current ? `ACTIVE STEP: ${current.id} — ${interpolate(current.instruction, { practice_name: practiceName }, `step:${current.id}`)}` : 'ACTIVE STEP: none (wrap up and end the call)',
    '',
    'WHAT WE KNOW SO FAR (canonical clinical fields):',
    `  ${JSON.stringify(fields)}`,
    '',
    'CLINICAL RED FLAGS THE SYSTEM WATCHES (you do not decide escalation; rules do):',
    ...redFlags,
    '',
    'RULES:',
    '1. Speak at most 2 short sentences per turn. Never list questions.',
    '2. Never give medical advice, diagnosis, or medication dosing.',
    '3. Record facts the patient gives you using the tools; call tools BEFORE answering.',
    '4. Never invent a value the patient did not state. If unknown, ask.',
    '5. Only the current step is yours to complete; you cannot skip ahead.',
    '6. Output only spoken words. No JSON, no markdown, no stage directions.',
    ...(hint ? ['', `NOTE: ${hint}`] : []),
  ].join('\n');
}

export function buildTurnMessages(input: PromptInput): ChatMessage[] {
  const history = input.transcript.slice(-12);
  const messages: ChatMessage[] = [...history];
  if (input.patientUtterance.trim().length > 0) {
    messages.push({ role: 'user', content: input.patientUtterance });
  }
  return messages;
}

/** Extra nudge appended when a step attempt failed, so retries are rephrased. */
export function failureHint(action: StepFailureAction | undefined): string | null {
  if (!action) return null;
  if (action.kind === 'retry') {
    return `The patient did not satisfy step "${action.stepId}" (attempt ${action.attempt} of ${action.maxAttempts}). Ask again, phrased differently and shorter.`;
  }
  if (action.kind === 'advance_with_flag') {
    return `Step "${action.stepId}" was skipped after repeated failures and flagged for staff follow-up. Move on and do not re-ask about it.`;
  }
  if (action.kind === 'warm_transfer_to_staff') {
    return `Step "${action.stepId}" failed repeatedly. Tell the patient a member of staff will call them back, then end the call.`;
  }
  return `Step "${action.stepId}" could not be completed. Move on and mention it in your summary.`;
}
