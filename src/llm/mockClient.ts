import type { AppLogger } from '../common/logger.js';
import { noopLogger } from '../common/logger.js';
import type { ExtractionError } from './errors.js';
import type { ChatInput, ChatMessage, ChatResult, ExtractInput, LlmClient, ToolCall } from './types.js';
import { TOOL_NAMES } from '../tools/definitions.js';

/**
 * Mock LLM. Makes the pipeline testable and the eval harness runnable with no GPU and no
 * cloud credential. Three modes:
 *
 *  - `echo`     : parrots the patient utterance (transport / plumbing smoke tests).
 *  - `replay`   : replays a queue of raw responses — the workhorse for unit tests, where
 *                 the queue is deliberately full of malformed tool-call shapes.
 *  - `scripted` : answers per active step (parsed out of the system prompt), driving the
 *                 canonical tools — used by `npm run eval -- --mock`.
 *
 * IMPORTANT: mock-mode eval numbers measure PIPELINE correctness (orchestration,
 * escalation, persistence), never model quality. Reported as such in eval output.
 */
export type MockMode = 'echo' | 'replay' | 'scripted';

export interface MockResponse {
  text?: string;
  /** Raw provider-style payload; when present it goes through parseToolCallResponse. */
  toolCalls?: ToolCall[];
  stepComplete?: boolean;
  errorOnFirst?: { message: string };
}

export interface ScriptedStepReply {
  stepId: string;
  utterance: string;
  toolCalls?: ToolCall[];
  stepComplete?: boolean;
}

export interface MockLlmClientOptions {
  mode?: MockMode;
  responses?: MockResponse[];
  script?: ScriptedStepReply[];
  /** Queue consumed by extractStructured (tests / deterministic judge). */
  structured?: unknown[];
  latencyMs?: number;
  logger?: AppLogger;
}

const DEFAULT_SCRIPT: ScriptedStepReply[] = [
  { stepId: 'greeting', utterance: 'Hello, this is the follow-up call from the clinic.', stepComplete: true },
  {
    stepId: 'identity_verification',
    utterance: 'Can you confirm your date of birth for me?',
    stepComplete: false,
  },
  {
    stepId: 'symptom_check',
    utterance: 'How are you feeling today — any pain, fever, or trouble breathing?',
    stepComplete: false,
  },
  {
    stepId: 'medication_review',
    utterance: 'Have you been able to take your medications as prescribed?',
    stepComplete: false,
  },
  {
    stepId: 'wrap_up',
    utterance: 'Thanks — I will note that down. Take care.',
    stepComplete: true,
    toolCalls: [{ id: 'wrap_up', name: 'end_call', arguments: { outcome: 'completed' } }],
  },
];

const ACTIVE_STEP = /ACTIVE STEP:\s*([a-z_0-9]+)/;

export class MockLlmClient implements LlmClient {
  readonly kind = 'mock' as const;
  private readonly mode: MockMode;
  private readonly queue: MockResponse[];
  private readonly script: ScriptedStepReply[];
  private readonly structured: unknown[];
  private readonly latencyMs: number;
  private readonly logger: AppLogger;
  private replies = 0;
  /** Tool names the mock has emitted — lets tests assert tool flow without a DB. */
  readonly emittedToolCalls: ToolCall[] = [];

  constructor(options: MockLlmClientOptions = {}) {
    this.mode = options.mode ?? 'echo';
    this.queue = [...(options.responses ?? [])];
    this.script = options.script ?? DEFAULT_SCRIPT;
    this.structured = [...(options.structured ?? [])];
    this.latencyMs = options.latencyMs ?? 0;
    this.logger = options.logger ?? noopLogger;
  }

  get turnCount(): number {
    return this.replies;
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }

  private scripted(system: string, turnIndex: number): MockResponse {
    const match = ACTIVE_STEP.exec(system);
    const stepId = match?.[1];
    const reply = stepId ? this.script.find((entry) => entry.stepId === stepId) : undefined;
    if (!reply) {
      return { text: 'I am sorry, could you say that again?', toolCalls: [], stepComplete: false };
    }
    // Ask-once semantics: on the second visit to a question step, accept the answer as
    // evidence via the tools the script attached (or nothing at all).
    void turnIndex;
    return {
      text: reply.utterance,
      toolCalls: reply.toolCalls ?? [],
      stepComplete: reply.stepComplete ?? false,
    };
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    await this.delay();
    this.replies += 1;
    const next = this.mode === 'replay' ? this.queue.shift() : this.scripted(input.system, this.replies);
    if (next?.errorOnFirst) {
      this.logger.debug({ error: next.errorOnFirst.message }, 'mock client surfacing scripted error');
    }
    const toolCalls = next?.toolCalls ?? [];
    this.emittedToolCalls.push(...toolCalls);
    return {
      text: next?.text ?? echoText(input.messages),
      toolCalls,
      stepComplete: next?.stepComplete,
      raw: { mock: true, mode: this.mode },
    };
  }

  async extractStructured<T>(input: ExtractInput<T>): Promise<T> {
    await this.delay();
    const next = this.structured.shift();
    const parsed = input.schema.safeParse(next ?? {});
    if (parsed.success) return parsed.data;
    // Deliberate type: keep the pipeline moving in mock mode; the caller's own
    // safeParse path (eval judge) decides how to score an unusable verdict.
    return (next ?? {}) as T;
  }
}

function echoText(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return `[mock] you said: ${lastUser?.content ?? ''}`;
}

export type { ExtractionError };
export { TOOL_NAMES };
