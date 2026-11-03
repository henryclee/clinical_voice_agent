import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AppLogger } from '../common/logger.js';
import { noopLogger } from '../common/logger.js';
import { ExtractionError, LlmCallError, isTimeoutError, messageOf, statusOf, unsupportedParameterName } from './errors.js';
import { parseToolCallResponse, stripReasoning, tolerantJsonParse } from './parseToolCalls.js';
import { recordParamFallback } from './stats.js';
import { TOOL_NAMES } from '../tools/definitions.js';
import type { ChatInput, ChatMessage, ChatResult, ExtractInput, LlmClient } from './types.js';

/**
 * OpenAI-compatible client for the local omlx endpoint (and any other v1 server).
 *
 * Two behaviours this codebase depends on:
 *  1. Graceful parameter degradation: if the server rejects `response_format` or
 *     `tools`, it is disabled for the rest of the process, counted, and the request is
 *     retried — the tolerant tool-call parser picks up the fallout.
 *  2. Bounded retry with exponential backoff + jitter for timeouts / 5xx / 429.
 */
export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: AppLogger;
  /** Merged into every request body (e.g. {"chat_template_kwargs":{"enable_thinking":false}}). */
  extraBody?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = Math.min(8_000, 500 * 2 ** (attempt - 1));
  return base + Math.random() * base * 0.3;
}

function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status === 429 || status >= 500;
  return isTimeoutError(error);
}

function toOpenAiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant', content: message.content ?? null };
      if (message.toolCalls && message.toolCalls.length > 0) {
        out.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }));
      }
      return out;
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId ?? 'unknown', content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

export class OpenAiCompatClient implements LlmClient {
  readonly kind = 'real' as const;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly logger: AppLogger;
  private readonly maxRetries: number;
  private readonly extraBody: Record<string, unknown>;
  private supportsResponseFormat = true;
  private supportsTools = true;

  constructor(options: OpenAiCompatOptions) {
    this.model = options.model;
    this.logger = options.logger ?? noopLogger;
    this.maxRetries = options.maxRetries ?? 3;
    this.extraBody = options.extraBody ?? {};
    this.client = new OpenAI({
      baseURL: options.baseUrl,
      apiKey: options.apiKey || 'not-needed',
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }

  /** Visible for tests/telemetry. */
  get parameterSupport(): { response_format: boolean; tools: boolean } {
    return { response_format: this.supportsResponseFormat, tools: this.supportsTools };
  }

  private async withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: unknown;
    // Loop: parameter-fallback retries do not consume the backoff budget.
    for (let guard = 0; guard < this.maxRetries * 2 + 4; guard += 1) {
      try {
        return await run();
      } catch (error) {
        lastError = error;
        const message = messageOf(error);
        const param = unsupportedParameterName(message);
        if (param === 'response_format' && this.supportsResponseFormat) {
          this.supportsResponseFormat = false;
          recordParamFallback('response_format');
          this.logger.warn({ label }, 'endpoint rejected response_format — disabled for this process');
          continue;
        }
        if (param === 'tools' && this.supportsTools) {
          this.supportsTools = false;
          recordParamFallback('tools');
          this.logger.warn({ label }, 'endpoint rejected tools — falling back to inline tool-call parsing');
          continue;
        }
        if (!isRetryable(error)) break;
        attempt += 1;
        if (attempt > this.maxRetries) break;
        this.logger.warn({ label, attempt, error: message }, 'llm call failed, retrying');
        await sleep(backoffMs(attempt));
      }
    }
    throw new LlmCallError(`llm ${label} failed: ${messageOf(lastError)}`, {
      status: statusOf(lastError),
      attempts: attempt + 1,
      retryable: isRetryable(lastError),
    });
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const messages = [{ role: 'system', content: input.system }, ...toOpenAiMessages(input.messages)];
    return this.withRetry('chat', async () => {
      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature: input.temperature ?? 0.3,
        max_tokens: input.maxTokens ?? 400,
        ...this.extraBody,
      };
      if (this.supportsTools && input.tools && input.tools.length > 0) {
        body.tools = input.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        body.tool_choice = 'auto';
      }
      const response = (await this.client.chat.completions.create(body as never)) as {
        choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[];
      };
      const message = response.choices?.[0]?.message;
      const rawText = typeof message?.content === 'string' ? message.content : '';
      const parsed = parseToolCallResponse({
        native: message?.tool_calls,
        text: rawText,
        knownToolNames: TOOL_NAMES,
      });
      if (parsed.rejected.length > 0) {
        this.logger.warn({ rejected: parsed.rejected, tier: parsed.tier }, 'tool-call parse rejected some calls');
      }
      if (parsed.toolCalls.length > 0 && parsed.tier !== 'native') {
        this.logger.info({ tier: parsed.tier }, 'tool calls recovered from message text');
      }
      return { text: stripReasoning(rawText), toolCalls: parsed.toolCalls, raw: response };
    });
  }

  /**
   * Structured extraction with three levels of fallback:
   * strict json_schema -> (endpoint rejects it) plain JSON instruction -> tolerant parse
   * of whatever came back -> ExtractionError after two attempts.
   */
  async extractStructured<T>(input: ExtractInput<T>): Promise<T> {
    const jsonSchema = zodToJsonSchema(input.schema, { name: 'extraction_result' }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const messages: Record<string, unknown>[] = [
      {
        role: 'system',
        content: `${input.system}\nReturn ONLY a JSON object matching the schema. No prose, no code fences.`,
      },
      { role: 'user', content: input.user },
    ];
    let issues: string[] = ['no attempt'];
    let lastRaw = '';

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await this.withRetry('extract', async () => {
        const body: Record<string, unknown> = {
          model: this.model,
          messages,
          temperature: 0,
          max_tokens: 512,
          ...this.extraBody,
        };
        if (this.supportsResponseFormat) {
          body.response_format = {
            type: 'json_schema',
            json_schema: { name: 'extraction_result', strict: true, schema: jsonSchema },
          };
        }
        return (await this.client.chat.completions.create(body as never)) as {
          choices?: { message?: { content?: string | null } }[];
        };
      });

      const content = response.choices?.[0]?.message?.content ?? '';
      lastRaw = content;
      const parsed = tolerantJsonParse(content);
      if (parsed) {
        const validated = input.schema.safeParse(parsed.value);
        if (validated.success) return validated.data;
        issues = validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      } else {
        issues = ['response was not valid JSON'];
      }
      messages.push({ role: 'assistant', content: content.slice(0, 500) });
      messages.push({
        role: 'user',
        content: `That did not validate (${issues.join('; ')}). Return ONLY corrected JSON.`,
      });
    }

    throw new ExtractionError('structured extraction failed after 2 attempts', issues, lastRaw);
  }

  /**
   * Multimodal extraction (photographed discharge papers). Only meaningful against a
   * vision-capable endpoint; a text-only server fails with a typed LlmCallError and the
   * caller falls back to OCR or a text document.
   */
  async extractStructuredWithImage<T>(input: ExtractInput<T> & { dataUrl: string }): Promise<T> {
    const jsonSchema = zodToJsonSchema(input.schema, { name: 'extraction_result' }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: `${input.system}\nReturn ONLY a JSON object matching the schema.` },
      {
        role: 'user',
        content: [
          { type: 'text', text: input.user },
          { type: 'image_url', image_url: { url: input.dataUrl } },
        ],
      },
    ];

    const response = await this.withRetry('extract_vision', async () => {
      const body: Record<string, unknown> = { model: this.model, messages, temperature: 0, max_tokens: 700, ...this.extraBody };
      if (this.supportsResponseFormat) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'extraction_result', strict: true, schema: jsonSchema },
        };
      }
      return (await this.client.chat.completions.create(body as never)) as {
        choices?: { message?: { content?: string | null } }[];
      };
    });

    const content = response.choices?.[0]?.message?.content ?? '';
    const parsed = tolerantJsonParse(content);
    if (!parsed) throw new ExtractionError('vision response was not JSON', [], content);
    const validated = input.schema.safeParse(parsed.value);
    if (!validated.success) {
      throw new ExtractionError(
        'vision response failed schema validation',
        validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        content,
      );
    }
    return validated.data;
  }
}

