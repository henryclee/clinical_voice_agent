import type { z } from 'zod';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Assistant messages may carry tool calls (used when replaying transcripts). */
  toolCalls?: ToolCall[];
  /** For `role: 'tool'` messages: the call this payload answers. */
  toolCallId?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema compiled from a Zod schema via zod-to-json-schema. */
  parameters: Record<string, unknown>;
}

export interface ChatInput {
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  /** Agent utterance after reasoning-block stripping; absent if the model only called tools. */
  text?: string;
  toolCalls: ToolCall[];
  /**
   * Explicit "current step is done" signal. Fixtures and the mock client provide it;
   * real endpoints usually omit it, in which case the orchestrator falls back to the
   * deterministic `stepSatisfied()` evidence check.
   */
  stepComplete?: boolean;
  raw: unknown;
}

export interface ExtractInput<T> {
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  system: string;
  user: string;
}

/**
 * The single seam that makes the orchestrator testable and the eval harness possible:
 * everything above it is identical for mock and real runs.
 */
export interface LlmClient {
  readonly kind: 'mock' | 'real';
  chat(input: ChatInput): Promise<ChatResult>;
  extractStructured<T>(input: ExtractInput<T>): Promise<T>;
  /** Optional multimodal extraction; only present on vision-capable clients. */
  extractStructuredWithImage?<T>(input: ExtractInput<T> & { dataUrl: string }): Promise<T>;
}
