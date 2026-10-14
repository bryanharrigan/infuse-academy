/**
 * In-memory event log for the Silfab Solar installer-portal demo.
 *
 * Absorb pushes a Webhook the moment a certificate is awarded. The portal
 * page watches `version` and re-runs its certification check whenever it
 * changes, so the billing-hold gate clears on screen without a refresh.
 *
 * ── Why a version counter and not the payload ───────────────────────
 * Absorb Webhook payloads are deliberately lean: event name, the learner's
 * User ID, client ID and correlation ID. They do NOT say which certificate
 * or course. Absorb's own guidance is that the receiver calls the
 * Integration API to learn what actually changed.
 *
 * So this store treats an event as a *signal to re-check*, never as the
 * answer. The authoritative verdict still comes from
 * `my-course-enrollments/{id}` scoped to the signed-in learner's own token,
 * which also sidesteps having to map Absorb User IDs onto portal sessions.
 *
 * ── Durability ──────────────────────────────────────────────────────
 * Deliberately in-process and volatile. It resets whenever the Infuse
 * service restarts, which includes every deploy. That is fine for a demo
 * and wrong for production - a real receiver would persist and de-duplicate
 * on correlationId.
 */

export type WebhookEvent = {
  /** Monotonic sequence number, 1-based. */
  seq: number;
  /** Absorb event name, e.g. "Certificate Awarded". */
  event: string;
  /** Absorb User ID of the learner the event concerns, when supplied. */
  userId?: string;
  /** Absorb's correlation ID for the delivery, used for de-duplication. */
  correlationId?: string;
  /** True only when the absorb-signature HMAC verified against our secret. */
  verified: boolean;
  /** ISO timestamp this receiver accepted the delivery. */
  receivedAt: string;
};

const MAX_EVENTS = 50;

const state: { version: number; events: WebhookEvent[] } = {
  version: 0,
  events: [],
};

/** Correlation IDs already recorded, so a retry does not double-count. */
const seenCorrelationIds = new Set<string>();

export function recordEvent(
  input: Omit<WebhookEvent, "seq" | "receivedAt">
): { duplicate: boolean; event: WebhookEvent | null } {
  if (input.correlationId && seenCorrelationIds.has(input.correlationId)) {
    return { duplicate: true, event: null };
  }
  if (input.correlationId) {
    seenCorrelationIds.add(input.correlationId);
    // Keep the de-dup set from growing without bound.
    if (seenCorrelationIds.size > MAX_EVENTS * 4) {
      const first = seenCorrelationIds.values().next().value;
      if (first) seenCorrelationIds.delete(first);
    }
  }

  state.version += 1;
  const event: WebhookEvent = {
    ...input,
    seq: state.version,
    receivedAt: new Date().toISOString(),
  };
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events.shift();

  return { duplicate: false, event };
}

export function getEventsSince(since: number): {
  version: number;
  events: WebhookEvent[];
} {
  return {
    version: state.version,
    events: state.events.filter((e) => e.seq > since),
  };
}

export function currentVersion(): number {
  return state.version;
}
