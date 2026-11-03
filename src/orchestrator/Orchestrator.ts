import type { AppLogger } from '../common/logger.js';
import { noopLogger } from '../common/logger.js';
import type { LoadedCallScript } from '../config/loadCallScript.js';
import { emptyClinicalFields, mergeClinicalFields, type ClinicalFields } from '../extraction/clinicalFields.js';
import {
  evaluateRules,
  forcesEscalatedOutcome,
  highest,
  SAFETY_MESSAGE_EMERGENT,
  SAFETY_MESSAGE_URGENT,
  type EscalationDecision,
} from '../escalation/engine.js';
import type { Notifier } from '../escalation/notify.js';
import type { Repositories } from '../db/repositories/types.js';
import type { CallOutcome } from '../db/schema.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { handleToolCall } from '../tools/handlers.js';
import { DischargeExtract } from '../extraction/dischargeParser.js';
import {
  buildSystemPrompt,
  buildTurnMessages,
  stepSatisfied,
  type PatientContext,
} from './promptBuilder.js';
import { renderSummaryText, summarize, fieldsFromExtractionRows, type StaffSummary } from '../extraction/summarize.js';
import { CallStateMachine, type StepFailureAction } from './stateMachine.js';
import type { ChatMessage, LlmClient, ToolCall } from '../llm/types.js';

/**
 * Transport-agnostic orchestrator.
 *
 * One `LlmClient.chat()` per conversational turn, with a bounded inner tool loop.
 * Guarantees enforced here — never delegated to the model:
 *  - the step cursor moves only through this class (the model can satisfy/complete the
 *    ACTIVE step; it can never skip ahead);
 *  - escalation is computed by the deterministic engine after every turn, so a model
 *    that never calls `flag_red_flag` still escalates (red-test assertion #4);
 *  - `calls.status` is telephony lifecycle, `calls.outcome` is agent logic — kept apart;
 *  - every call terminates (max_turns backstop) and persists a summary.
 *
 * Live call state is in-process (Map); Postgres holds the durable audit trail. Resuming
 * a half-finished call across a process restart is out of scope for P0 (see BUILD_REPORT).
 */

export const TRANSFER_MESSAGE =
  "I'm going to have a member of our care team call you back shortly. If anything feels urgent, call 911.";

const FALLBACK_UTTERANCE = "I'm sorry, could you say that again?";

export interface OrchestratorOptions {
  llm: LlmClient;
  repos: Repositories;
  script: LoadedCallScript;
  practiceName: string;
  notifier: Notifier;
  logger?: AppLogger;
  maxTurns?: number;
  maxToolIterations?: number;
  now?: () => Date;
}

export interface ToolOutcome {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export interface TurnResult {
  callId: string;
  agentUtterance: string;
  stepId: string | null;
  stepAdvanced: boolean;
  stepAttempt: { stepId: string; attempt: number; maxAttempts: number } | null;
  toolCalls: ToolOutcome[];
  escalations: EscalationDecision[];
  callEnded: boolean;
  outcome: CallOutcome | null;
  fields: ClinicalFields;
  latencyMs: number;
}

export interface CallSummary {
  callId: string;
  outcome: CallOutcome | null;
  status: string;
  fields: ClinicalFields;
  requiredSteps: string[];
  missingRequired: string[];
  flags: string[];
  transcript: { role: string; text: string; latencyMs: number | null }[];
  toolCalls: ToolOutcome[];
  summaryText: string;
  staff: StaffSummary;
}

interface CallState {
  callId: string;
  machine: CallStateMachine;
  fields: ClinicalFields;
  transcript: ChatMessage[];
  firedRules: Set<string>;
  turnCount: number;
  turnIdx: number;
  escalatedPending: boolean;
  transferPending: boolean;
  urgentAdvised: boolean;
  pendingFailure: StepFailureAction | undefined;
  ended: boolean;
  outcome: CallOutcome | null;
  patient: PatientContext;
  toolCalls: ToolOutcome[];
}

export class Orchestrator {
  private readonly llm: LlmClient;
  private readonly repos: Repositories;
  private readonly script: LoadedCallScript;
  private readonly practiceName: string;
  private readonly notifier: Notifier;
  private readonly logger: AppLogger;
  private readonly maxTurns: number;
  private readonly maxToolIterations: number;
  private readonly now: () => Date;
  private readonly states = new Map<string, CallState>();

  constructor(options: OrchestratorOptions) {
    this.llm = options.llm;
    this.repos = options.repos;
    this.script = options.script;
    this.practiceName = options.practiceName;
    this.notifier = options.notifier;
    this.logger = options.logger ?? noopLogger;
    this.maxTurns = options.maxTurns ?? 12;
    this.maxToolIterations = options.maxToolIterations ?? 3;
    this.now = options.now ?? (() => new Date());
  }

  /** Open a call (row created with status `in_progress`) and produce the greeting turn. */
  async start(input: { patientId: string; twilioCallSid?: string | null }): Promise<TurnResult> {
    const patient = await this.repos.patients.get(input.patientId);
    if (!patient) throw new Error(`Orchestrator: patient ${input.patientId} not found`);
    const scriptRow = await this.repos.callScripts.findByName(patient.orgId, this.script.script.id);
    const call = await this.repos.calls.create({
      patientId: input.patientId,
      callScriptId: scriptRow?.id ?? 'unpersisted-script',
      twilioCallSid: input.twilioCallSid ?? null,
      status: 'in_progress',
      startedAt: this.now(),
    });

    const state: CallState = {
      callId: call.id,
      machine: new CallStateMachine(this.script.script.steps),
      fields: emptyClinicalFields(),
      transcript: [],
      firedRules: new Set(),
      turnCount: 0,
      turnIdx: 0,
      escalatedPending: false,
      transferPending: false,
      urgentAdvised: false,
      pendingFailure: undefined,
      ended: false,
      outcome: null,
      patient: await this.toContext(patient.id),
      toolCalls: [],
    };
    this.states.set(call.id, state);
    this.logger.info(
      { callId: call.id, patientId: patient.id, script: this.script.script.id, llm: this.llm.kind },
      'call started',
    );
    return this.runTurn(state, '');
  }

  /** Feed one patient utterance and get the agent's reply plus a description of the turn. */
  async turn(callId: string, utterance: string): Promise<TurnResult> {
    const state = this.states.get(callId);
    if (!state) throw new Error(`Orchestrator: unknown call ${callId} (state is in-process)`);
    if (state.ended) throw new Error(`Orchestrator: call ${callId} already ended`);
    return this.runTurn(state, utterance);
  }

  private async toContext(patientId: string): Promise<PatientContext> {
    const patient = await this.repos.patients.get(patientId);
    if (!patient) throw new Error(`Orchestrator: patient ${patientId} not found`);
    const docs = await this.repos.dischargeDocuments.listByPatient(patientId);
    const latest = docs[docs.length - 1];
    const parsed = latest ? DischargeExtract.safeParse(latest.parsedJson) : undefined;
    const data = parsed?.success ? parsed.data : undefined;
    return {
      firstName: patient.firstName,
      lastName: patient.lastName,
      dob: patient.dob,
      externalRef: patient.externalRef,
      discharge: {
        primaryDiagnosis: data?.primary_diagnosis ?? 'unspecified',
        procedures: data?.procedures ?? [],
        medications: data?.medications ?? [],
        followUp: data?.follow_up ?? { provider: '', reason: '' },
        redFlags: data?.red_flags ?? [],
        dischargeDate: data?.discharge_date || undefined,
      },
    };
  }

  private async persistTurn(state: CallState, role: 'agent' | 'patient', text: string, latencyMs: number | null): Promise<void> {
    await this.repos.callTurns.append({ callId: state.callId, idx: state.turnIdx, role, text, latencyMs });
    state.turnIdx += 1;
  }

  private async runTurn(state: CallState, utterance: string): Promise<TurnResult> {
    const startedAt = Date.now();
    const stepAtStart = state.machine.current()?.id ?? null;
    state.turnCount += 1;

    if (utterance.trim().length > 0) {
      state.transcript.push({ role: 'user', content: utterance });
      await this.persistTurn(state, 'patient', utterance, null);
    }

    const promptInput = {
      script: this.script.script,
      practiceName: this.practiceName,
      patient: state.patient,
      machine: state.machine,
      fields: state.fields,
      transcript: state.transcript,
      patientUtterance: utterance,
      failure: state.pendingFailure,
    };
    const system = buildSystemPrompt(promptInput);
    const messages: ChatMessage[] = buildTurnMessages(promptInput);

    const toolOutcomes: ToolOutcome[] = [];
    const extractionRows: { field: string; value: unknown; confidence: number | null }[] = [];
    let reply = '';
    let stepCompleteSignal: boolean | undefined;
    let modelOutcome: CallOutcome | null = null;

    // Inner tool loop: tools are side effects of ONE conversational turn.
    for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
      const result = await this.llm.chat({
        system,
        messages,
        tools: TOOL_DEFINITIONS,
        temperature: 0.3,
        maxTokens: 400,
      });
      if (typeof result.stepComplete === 'boolean') stepCompleteSignal = result.stepComplete;

      const calls: ToolCall[] = result.toolCalls;
      if (calls.length > 0) {
        const results = await Promise.all(
          calls.map((call) =>
            handleToolCall(call.name, call.arguments, {
              callId: state.callId,
              practiceName: this.practiceName,
              logger: this.logger,
              repos: this.repos,
              now: this.now,
            }),
          ),
        );
        for (const [index, call] of calls.entries()) {
          const handled = results[index];
          if (!handled) continue;
          state.fields = mergeClinicalFields(state.fields, handled.fields);
          if (handled.nextSteps.length > 0) {
            state.fields = mergeClinicalFields(state.fields, { next_steps: handled.nextSteps });
          }
          extractionRows.push(...handled.extractions);
          const outcome: ToolOutcome = { name: call.name, arguments: call.arguments, ok: handled.ok, error: handled.error };
          toolOutcomes.push(outcome);
          state.toolCalls.push(outcome);
          if (handled.endCall) modelOutcome = handled.endCall;
        }
        messages.push({ role: 'assistant', content: result.text ?? '', toolCalls: calls });
        calls.forEach((call, index) => {
          const handled = results[index];
          if (handled) {
            messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(handled.toolResponse) });
          }
        });
        continue;
      }

      const text = (result.text ?? '').trim();
      if (text.length > 0) {
        reply = text;
        break;
      }
      // Neither text nor tools: one nudge, then the fallback line covers us.
      messages.push({ role: 'user', content: 'Please reply in one short spoken sentence.' });
    }

    if (extractionRows.length > 0) {
      await this.repos.extractions.appendMany(extractionRows.map((row) => ({ callId: state.callId, ...row })));
    }

    // --- deterministic escalation: runs EVERY turn regardless of what the model did ---
    const decisions = evaluateRules(this.script.script.escalation_rules, state.fields);
    const fresh = decisions.filter((decision) => !state.firedRules.has(decision.ruleId));
    for (const decision of fresh) {
      state.firedRules.add(decision.ruleId);
      await this.notifier.notify(decision, state.callId);
    }
    const top = highest(decisions);
    if (forcesEscalatedOutcome(top)) state.escalatedPending = true;
    const emergentNow = fresh.some((decision) => decision.urgency === 'emergent');

    let finalUtterance = reply;
    if (emergentNow) {
      // The safety line outranks whatever the model wanted to say.
      finalUtterance = SAFETY_MESSAGE_EMERGENT;
    } else if (fresh.some((decision) => decision.urgency === 'urgent') && !state.urgentAdvised) {
      state.urgentAdvised = true;
      finalUtterance = finalUtterance ? `${finalUtterance} ${SAFETY_MESSAGE_URGENT}` : SAFETY_MESSAGE_URGENT;
    }

    // --- step progression (cursor owned here; the model can never skip ahead) ---
    let stepAdvanced = false;
    let stepAttempt: TurnResult['stepAttempt'] = null;
    const terminatingNow = emergentNow;
    if (!terminatingNow && stepAtStart && state.machine.current()?.id === stepAtStart) {
      const satisfied = stepCompleteSignal === true || stepSatisfied(stepAtStart, state.fields);
      if (satisfied) {
        state.machine.completeCurrent();
        stepAdvanced = true;
        state.pendingFailure = undefined;
      } else {
        const failure = state.machine.failCurrent();
        const runtime = state.machine.stepById(failure.stepId);
        stepAttempt = {
          stepId: failure.stepId,
          attempt: runtime?.attempts ?? 1,
          maxAttempts: runtime?.maxAttempts ?? 1,
        };
        state.pendingFailure = failure;
        if (failure.kind === 'warm_transfer_to_staff') state.transferPending = true;
        this.logger.info({ callId: state.callId, ...failure }, 'step attempt failed');
      }
    }

    // --- termination policy ---
    let callEnded = false;
    let outcome: CallOutcome | null = null;
    if (terminatingNow) {
      callEnded = true;
      outcome = 'escalated';
    } else if (state.transferPending) {
      callEnded = true;
      outcome = 'escalated';
      finalUtterance = TRANSFER_MESSAGE;
    } else if (modelOutcome === 'refused') {
      callEnded = true;
      outcome = 'refused';
    } else if (modelOutcome) {
      callEnded = true;
      outcome = state.escalatedPending ? 'escalated' : state.machine.endOutcome();
    } else if (state.machine.isComplete() || state.turnCount >= this.maxTurns) {
      callEnded = true;
      outcome = state.escalatedPending
        ? 'escalated'
        : state.machine.isComplete()
          ? state.machine.endOutcome()
          : 'partial';
    }

    if (finalUtterance.length === 0) finalUtterance = FALLBACK_UTTERANCE;
    const latencyMs = Date.now() - startedAt;
    await this.persistTurn(state, 'agent', finalUtterance, latencyMs);
    state.transcript.push({ role: 'assistant', content: finalUtterance });

    if (callEnded && outcome) await this.persistOutcome(state, outcome);

    this.logger.info(
      {
        callId: state.callId,
        step: stepAtStart,
        stepAdvanced,
        tools: toolOutcomes.map((t) => `${t.name}${t.ok ? '' : ':failed'}`),
        escalations: fresh.map((e) => `${e.ruleId}/${e.urgency}`),
        callEnded,
        outcome,
        latencyMs,
      },
      'turn complete',
    );

    return {
      callId: state.callId,
      agentUtterance: finalUtterance,
      stepId: stepAtStart,
      stepAdvanced,
      stepAttempt,
      toolCalls: toolOutcomes,
      escalations: fresh,
      callEnded,
      outcome,
      fields: state.fields,
      latencyMs,
    };
  }

  /** External termination (patient hangs up, operator aborts, refusal from a route). */
  async end(callId: string, outcome: CallOutcome = 'refused'): Promise<CallSummary> {
    const state = this.states.get(callId);
    if (!state) throw new Error(`Orchestrator: unknown call ${callId}`);
    return this.persistOutcome(state, state.escalatedPending ? 'escalated' : outcome);
  }

  private async persistOutcome(state: CallState, outcome: CallOutcome): Promise<CallSummary> {
    state.ended = true;
    state.outcome = outcome;
    const escalations = await this.repos.escalations.listByCall(state.callId);
    const followups = await this.repos.followups.listByCall(state.callId);
    const summaryInput = {
      patientName: `${state.patient.firstName} ${state.patient.lastName}`,
      outcome,
      fields: state.fields,
      escalations,
      followups,
      flags: state.machine.flags,
      missingRequired: state.machine.remainingRequired(),
    };
    const staff = summarize(summaryInput);
    const summaryText = renderSummaryText(staff, summaryInput);
    await this.repos.calls.update(state.callId, {
      outcome,
      status: 'completed',
      endedAt: this.now(),
      summaryText,
    });
    this.states.delete(state.callId);
    this.logger.info({ callId: state.callId, outcome, escalations: escalations.length }, 'call ended');
    return {
      callId: state.callId,
      outcome,
      status: 'completed',
      fields: state.fields,
      requiredSteps: this.script.requiredSteps,
      missingRequired: state.machine.remainingRequired(),
      flags: [...state.machine.flags],
      transcript: state.transcript.map((message) => ({ role: message.role, text: message.content, latencyMs: null })),
      toolCalls: state.toolCalls,
      summaryText,
      staff,
    };
  }

  /**
   * Reconstruct a call summary from persisted rows (works after a process restart,
   * unlike the in-flight state map).
   */
  async summary(callId: string): Promise<CallSummary> {
    const call = await this.repos.calls.get(callId);
    if (!call) throw new Error(`Orchestrator: unknown call ${callId}`);
    const [turns, extractions, escalations, followups, patient] = await Promise.all([
      this.repos.callTurns.listByCall(callId),
      this.repos.extractions.listByCall(callId),
      this.repos.escalations.listByCall(callId),
      this.repos.followups.listByCall(callId),
      this.repos.patients.get(call.patientId),
    ]);
    const fields = fieldsFromExtractionRows(extractions, emptyClinicalFields());
    const missingRequired = this.script.requiredSteps.filter((stepId) => !stepSatisfied(stepId, fields));
    const name = patient ? `${patient.firstName} ${patient.lastName}` : 'unknown patient';
    const summaryInput = {
      patientName: name,
      outcome: call.outcome,
      fields,
      escalations,
      followups,
      flags: [] as string[],
      missingRequired,
    };
    const staff = summarize(summaryInput);
    return {
      callId,
      outcome: call.outcome,
      status: call.status,
      fields,
      requiredSteps: this.script.requiredSteps,
      missingRequired,
      flags: [],
      transcript: turns.map((turn) => ({ role: turn.role, text: turn.text, latencyMs: turn.latencyMs })),
      toolCalls: [],
      staff,
      summaryText: call.summaryText ?? renderSummaryText(staff, summaryInput),
    };
  }
}




