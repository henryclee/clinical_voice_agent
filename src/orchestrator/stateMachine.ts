import type { CallScriptStep, StepOnFailure } from '../config/schema.js';
import type { CallOutcome } from '../db/schema.js';

/**
 * Step cursor + attempt policy. The LLM never decides which step is next: it may mark
 * the *current* step complete (`step_complete` / an on-step tool call), it may never
 * skip ahead, and failure handling follows the script's `on_failure` verbatim.
 */

export type StepState = 'pending' | 'active' | 'done' | 'failed' | 'flagged';

export interface StepRuntime {
  id: string;
  instruction: string;
  required: boolean;
  maxAttempts: number;
  onFailure: StepOnFailure;
  attempts: number;
  state: StepState;
}

export type StepFailureAction =
  | { kind: 'retry'; stepId: string; attempt: number; maxAttempts: number }
  | { kind: 'advance_with_flag'; stepId: string }
  | { kind: 'warm_transfer_to_staff'; stepId: string }
  | { kind: 'exhausted'; stepId: string };

const TERMINAL: StepState[] = ['done', 'failed', 'flagged'];

export class CallStateMachine {
  private readonly runtimes: StepRuntime[];
  readonly flags: string[] = [];

  constructor(steps: readonly CallScriptStep[]) {
    if (steps.length === 0) throw new Error('CallStateMachine: script has no steps');
    this.runtimes = steps.map((step, index) => ({
      id: step.id,
      instruction: step.instruction,
      required: step.required,
      maxAttempts: step.max_attempts,
      onFailure: step.on_failure,
      attempts: 0,
      state: index === 0 ? 'active' : 'pending',
    }));
  }

  get steps(): readonly StepRuntime[] {
    return this.runtimes;
  }

  current(): StepRuntime | null {
    return this.runtimes.find((step) => step.state === 'active') ?? null;
  }

  stepById(id: string): StepRuntime | undefined {
    return this.runtimes.find((step) => step.id === id);
  }

  isComplete(): boolean {
    return this.runtimes.every((step) => TERMINAL.includes(step.state));
  }

  remainingRequired(): string[] {
    return this.runtimes.filter((step) => step.required && step.state !== 'done').map((step) => step.id);
  }

  /** True when every required step reached `done` (flags/failures make it partial). */
  allRequiredDone(): boolean {
    return this.remainingRequired().length === 0;
  }

  private activateNext(): void {
    const next = this.runtimes.find((step) => step.state === 'pending');
    if (next) next.state = 'active';
  }

  /** Model signalled the current step is satisfied. */
  completeCurrent(): StepRuntime | null {
    const step = this.current();
    if (!step) return null;
    step.state = 'done';
    this.activateNext();
    return step;
  }

  /**
   * Current step could not be satisfied this turn. Applies the script's `on_failure`
   * once the attempt budget is spent.
   */
  failCurrent(): StepFailureAction {
    const step = this.current();
    if (!step) return { kind: 'exhausted', stepId: '<none>' };
    step.attempts += 1;

    if (step.attempts < step.maxAttempts) {
      return { kind: 'retry', stepId: step.id, attempt: step.attempts, maxAttempts: step.maxAttempts };
    }

    if (step.onFailure === 'advance_with_flag') {
      step.state = 'flagged';
      this.flags.push(step.id);
      this.activateNext();
      return { kind: 'advance_with_flag', stepId: step.id };
    }

    if (step.onFailure === 'warm_transfer_to_staff') {
      step.state = 'failed';
      this.activateNext();
      return { kind: 'warm_transfer_to_staff', stepId: step.id };
    }

    step.state = 'failed';
    this.activateNext();
    return { kind: 'exhausted', stepId: step.id };
  }

  /**
   * Outcome when the walk finishes normally. Escalation overrides this at the
   * orchestrator level (`escalated`), and refusal is signalled separately.
   */
  endOutcome(): CallOutcome {
    return this.allRequiredDone() ? 'completed' : 'partial';
  }
}
