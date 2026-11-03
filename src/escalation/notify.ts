import type { AppLogger } from '../common/logger.js';
import type { EscalationsRepo, FollowupsRepo } from '../db/repositories/types.js';
import type { EscalationDecision } from './engine.js';

/**
 * Escalation side-effects. Persistence is the guarantee ("never silently swallowed");
 * an optional webhook is best-effort and never allowed to break the call loop.
 */
export interface Notifier {
  notify(decision: EscalationDecision, callId: string): Promise<void>;
}

export interface NotifyDeps {
  escalations: EscalationsRepo;
  logger: AppLogger;
  webhookUrl?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createNotifier(deps: NotifyDeps): Notifier {
  return {
    async notify(decision, callId): Promise<void> {
      await deps.escalations.append({
        callId,
        ruleId: decision.ruleId,
        reason: decision.reason,
        urgency: decision.urgency,
        status: 'open',
      });
      deps.logger.warn(
        { callId, ruleId: decision.ruleId, urgency: decision.urgency, field: decision.field },
        'escalation recorded',
      );

      const webhookUrl = deps.webhookUrl ?? null;
      if (!webhookUrl) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5_000);
      try {
        const response = await (deps.fetchImpl ?? fetch)(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ callId, ...decision }),
          signal: controller.signal,
        });
        if (!response.ok) {
          deps.logger.error(
            { callId, ruleId: decision.ruleId, status: response.status },
            'escalation webhook failed (escalation row still recorded)',
          );
        }
      } catch (error) {
        deps.logger.error(
          { callId, ruleId: decision.ruleId, error: error instanceof Error ? error.message : String(error) },
          'escalation webhook error (escalation row still recorded)',
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Callback bookkeeping lives in its own repo; surfaced for the summary block. */
export async function listFollowups(followups: FollowupsRepo, callId: string) {
  return followups.listByCall(callId);
}
