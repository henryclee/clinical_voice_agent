import {
  CALL_STATUSES,
  type CallOutcome,
  type CallStatus,
} from '../db/schema.js';

/** TwiML builders. Kept as string builders so the output is readable in tests. */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function twimlWrap(inner: string[]): string {
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>', ...inner.map((line) => `  ${line}`), '</Response>'].join('\n');
}

/** Answer and open a Twilio Media Stream to our WebSocket endpoint. */
export function twimlAnswerWithStream(wssUrl: string): string {
  return twimlWrap(['<Connect>', `<Stream url="${escapeXml(wssUrl)}" />`, '</Connect>']);
}

/** Warm transfer: short spoken notice, then bridge to the staff line. */
export function twimlWarmTransfer(staffNumber: string, message: string): string {
  return twimlWrap([
    `<Say>${escapeXml(message)}</Say>`,
    `<Dial timeout="20" record="record-from-answer-dual">${escapeXml(staffNumber)}</Dial>`,
  ]);
}

export function twimlSay(message: string): string {
  return twimlWrap([`<Say>${escapeXml(message)}</Say>`]);
}

/**
 * Map a Twilio status-callback value onto `calls.status` (telephony lifecycle ONLY —
 * `calls.outcome` is agent logic and is never written from here).
 */
export function mapTwilioStatus(raw: string | undefined): CallStatus | null {
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if ((CALL_STATUSES as readonly string[]).includes(normalized)) return normalized as CallStatus;
  switch (normalized) {
    case 'queued':
    case 'ringing':
      return 'ringing';
    case 'in-progress':
    case 'in_progress':
    case 'answering':
      return 'in_progress';
    case 'completed':
    case 'answering machine':
      return 'completed';
    case 'no-answer':
    case 'no_answer':
    case 'not-in-service':
      return 'no_answer';
    case 'failed':
    case 'canceled':
    case 'busy':
      return 'failed';
    default:
      return null;
  }
}

export const TERMINAL_CALL_STATUSES: CallStatus[] = ['completed', 'failed', 'no_answer'];

/** Outcome a *dropped* call implies (never a model decision; telephony-only). */
export function outcomeForAbandonedStatus(status: CallStatus): CallOutcome | null {
  if (status === 'no_answer' || status === 'failed') return 'partial';
  return null;
}
