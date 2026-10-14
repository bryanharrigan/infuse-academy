import { json, LoaderFunctionArgs } from "@remix-run/node";
import { getEventsSince } from "~/.server/silfab-events";

/**
 * GET /api/silfab/events?since=<seq>
 *
 * The portal page polls this so it can react the moment Absorb pushes a
 * "Certificate Awarded" Webhook, rather than polling Absorb itself.
 *
 * ── Why the browser still polls ─────────────────────────────────────
 * Worth being precise about, because the distinction is the whole point:
 *
 *   Absorb  ->  this server   is a PUSH. The Webhook arrives the instant
 *                             the certificate is awarded. No polling of
 *                             the LMS, no API call on a timer.
 *   server  ->  browser       is a short poll, because a page needs some
 *                             transport and this is the robust one.
 *
 * The expensive, rate-limited hop - asking the LMS "has anything changed?"
 * - is the one Webhooks remove. The cheap same-origin hop is what remains,
 * and it costs Absorb nothing.
 *
 * Returns only lean metadata. No secrets, no payload bodies.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const sinceRaw = url.searchParams.get("since");
  const since = Number.isFinite(Number(sinceRaw)) ? Math.max(0, Number(sinceRaw)) : 0;

  const { version, events } = getEventsSince(since);

  return json(
    { version, events },
    { headers: { "Cache-Control": "private, no-store" } }
  );
};
