import path from 'node:path';
import { config as readDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Environment loading with three tiers (see README "Environment variables"):
 *
 *  1. REQUIRED          — missing any -> hard boot failure listing what is missing.
 *  2. OPTIONAL          — missing -> documented default.
 *  3. OPTIONAL_PARTIAL  — missing *all* -> text-only mode (warn). Missing *some* of a
 *     coherent group (Twilio / ElevenLabs) -> hard error naming the missing keys,
 *     because silently half-broken voice is worse than honest text-only mode.
 */

export class EnvError extends Error {
  readonly missing: string[];
  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = 'EnvError';
    this.missing = missing;
  }
}

const REQUIRED_VARS: ReadonlyArray<{ key: string; hint: string }> = [
  { key: 'DATABASE_URL', hint: 'Postgres URL — start the bundled database with `npm run db:up`' },
  { key: 'LLM_BASE_URL', hint: 'OpenAI-compatible endpoint — omlx default http://localhost:8080/v1' },
  { key: 'LLM_MODEL', hint: 'model id served by that endpoint — e.g. Qwen3.8-Flash-Next-oQ4e-mtp' },
  {
    key: 'LLM_API_KEY',
    hint: 'the key omlx was started with (~/.omlx/settings.json -> auth.api_key); no default on purpose',
  },
];

const REQUIRED_DEFAULTS: Record<string, string> = {
  DATABASE_URL: 'postgres://postgres:***@localhost:5432/clinical_voice',
  LLM_BASE_URL: 'http://localhost:8080/v1',
  LLM_MODEL: 'Qwen3.8-Flash-Next-oQ4e-mtp',
};

const TwilioShape = z.object({
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_FROM_NUMBER: z.string().min(1),
  PUBLIC_HOST: z.string().min(1),
});

const ElevenLabsShape = z.object({
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID: z.string().min(1),
});

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  publicHost: string;
}

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
}

export interface AppEnv {
  databaseUrl: string;
  llm: { baseUrl: string; model: string; apiKey: string };
  judge: { baseUrl: string; model: string };
  practiceName: string;
  logLevel: string;
  deepgramApiKey: string | null;
  elevenlabs: ElevenLabsConfig | null;
  twilio: TwilioConfig | null;
  /** true when no voice-provider credentials are configured at all. */
  textOnly: boolean;
  /** MOCK_LLM=true swaps in the scripted mock client (P0 acceptance without a GPU). */
  mockLlm: boolean;
  escalationWebhookUrl: string | null;
  /** Optional staff number for warm transfers (Twilio <Dial>). */
  escalationStaffNumber: string | null;
  publicHost: string | null;
  port: number;
  host: string;
}

function trimmed(key: string): string | undefined {
  const raw = process.env[key];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function partialGroupError(name: string, missing: string[]): EnvError {
  return new EnvError(
    `${name} configuration is incomplete — missing ${missing.join(', ')}. ` +
      'Either provide all of them or remove them all to run in text-only mode.',
    missing,
  );
}

export interface LoadEnvOptions {
  /** Directory containing `.env` (defaults to process.cwd()). */
  cwd?: string;
  /** When false, missing REQUIRED vars fall back to documented dev defaults (tests/tooling). */
  requireRequired?: boolean;
  /** Skip reading a `.env` file (explicit process.env only). */
  skipDotenv?: boolean;
}

export function loadEnv(options: LoadEnvOptions = {}): AppEnv {
  if (options.skipDotenv !== true) {
    readDotenv({ path: path.join(options.cwd ?? process.cwd(), '.env'), quiet: true });
  }

  const requireRequired = options.requireRequired !== false;
  const missing = REQUIRED_VARS.filter((v) => trimmed(v.key) === undefined);
  if (missing.length > 0) {
    if (requireRequired) {
      const list = missing.map((v) => `  - ${v.key}: ${v.hint}`).join('\n');
      throw new EnvError(
        `Missing required environment variables:\n${list}\n\nCopy .env.example to .env and fill them in.`,
        missing.map((v) => v.key),
      );
    }
    for (const v of missing) {
      const fallback = REQUIRED_DEFAULTS[v.key];
      if (fallback === undefined) {
        throw new EnvError(`Missing required environment variable ${v.key} and no dev default exists`, [v.key]);
      }
      process.env[v.key] = fallback;
    }
  }

  const twilioKeys = Object.keys(TwilioShape.shape);
  const twilioPresent = twilioKeys.filter((k) => trimmed(k) !== undefined);
  let twilio: TwilioConfig | null = null;
  if (twilioPresent.length > 0) {
    if (twilioPresent.length !== twilioKeys.length) {
      throw partialGroupError(
        'Twilio',
        twilioKeys.filter((k) => !twilioPresent.includes(k)),
      );
    }
    const parsed = TwilioShape.safeParse(process.env);
    if (!parsed.success) {
      throw partialGroupError(
        'Twilio',
        parsed.error.issues.map((i) => String(i.path[0])),
      );
    }
    twilio = {
      accountSid: parsed.data.TWILIO_ACCOUNT_SID,
      authToken: parsed.data.TWILIO_AUTH_TOKEN,
      fromNumber: parsed.data.TWILIO_FROM_NUMBER,
      publicHost: parsed.data.PUBLIC_HOST.replace(/^https?:\/\//, ''),
    };
  }

  const elKeys = Object.keys(ElevenLabsShape.shape);
  const elPresent = elKeys.filter((k) => trimmed(k) !== undefined);
  let elevenlabs: ElevenLabsConfig | null = null;
  if (elPresent.length > 0) {
    if (elPresent.length !== elKeys.length) {
      throw partialGroupError(
        'ElevenLabs',
        elKeys.filter((k) => !elPresent.includes(k)),
      );
    }
    const parsed = ElevenLabsShape.parse(process.env);
    elevenlabs = { apiKey: parsed.ELEVENLABS_API_KEY, voiceId: parsed.ELEVENLABS_VOICE_ID };
  }

  const deepgramApiKey = trimmed('DEEPGRAM_API_KEY') ?? null;
  const textOnly = twilio === null && elevenlabs === null && deepgramApiKey === null;

  const llmBaseUrl = trimmed('LLM_BASE_URL') ?? REQUIRED_DEFAULTS.LLM_BASE_URL;
  const llmModel = trimmed('LLM_MODEL') ?? REQUIRED_DEFAULTS.LLM_MODEL;

  return {
    databaseUrl: trimmed('DATABASE_URL') ?? REQUIRED_DEFAULTS.DATABASE_URL,
    llm: { baseUrl: llmBaseUrl, model: llmModel, apiKey: trimmed('LLM_API_KEY') ?? '' },
    judge: {
      baseUrl: trimmed('JUDGE_BASE_URL') ?? llmBaseUrl,
      model: trimmed('JUDGE_MODEL') ?? llmModel,
    },
    practiceName: trimmed('PRACTICE_NAME') ?? 'Sunrise Medical Group',
    logLevel: trimmed('LOG_LEVEL') ?? 'info',
    deepgramApiKey,
    elevenlabs,
    twilio,
    textOnly,
    mockLlm: (trimmed('MOCK_LLM') ?? 'false').toLowerCase() === 'true',
    escalationWebhookUrl: trimmed('ESCALATION_WEBHOOK_URL') ?? null,
    escalationStaffNumber: trimmed('ESCALATION_STAFF_NUMBER') ?? null,
    publicHost: twilio?.publicHost ?? null,
    port: Number(trimmed('PORT') ?? '3000'),
    host: trimmed('HOST') ?? '127.0.0.1',
  };
}
