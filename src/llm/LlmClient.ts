/**
 * Public LLM contract re-export.
 *
 * Kept as its own module (per the repo layout) so callers import the interface from a
 * stable path — `import type { LlmClient } from '../llm/LlmClient.js'` — without pulling
 * in an implementation.
 */
export type {
  ChatInput,
  ChatMessage,
  ChatResult,
  ChatRole,
  ExtractInput,
  LlmClient,
  ToolCall,
  ToolDefinition,
} from './types.js';
export { ExtractionError, LlmCallError, isTimeoutError, statusOf, unsupportedParameterName } from './errors.js';
