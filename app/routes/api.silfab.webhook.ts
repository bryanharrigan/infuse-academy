import { json, ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import crypto from "node:crypto";
import { recordEvent, currentVersion } from "~/.server/silfab-events";

/**
 * POST /api/silfab/webhook
 *
 * Absorb LMS Webhook receiver for the Silfab Solar installer-portal demo.
 * Configure in Absorb: Client Settings -> Webhooks -> Add new webhook
 *
 *   Name:   Certificate
 *   URL:    https://infuse.bryanharrigan.dev/api/silfab/webhook
 *   Events: Certificate Awarded
 *   Secret: copy the generated key into SILFAB_WEBHOOK_SECRET on the origin
 *
 * ── Signature verification ──────────────────────────────────────────
 * Absorb sends an `absorb-signature` header: HMAC-SHA256 over the RAW
 * request body, keyed with the Webhook's Secret Key. We recompute it from
 * `await request.text()` - the raw text, never a re-serialised object,
 * because any whitespace change alters the hash.
 *
 * ── The Test Webhook trap ───────────────────────────────────────────
 * Absorb's "Test Webhook" button sends a RANDOMLY generated signature that
 * cannot be validated against the Secret Key. A receiver that rejects bad
 * signatures therefore makes the Test button report failure, which looks
 * like a broken integration during a demo.
 *
 * So: always answer 200, but only act on VERIFIED deliveries. Unverified
 * ones are acknowledged and logged as unverified, never allowed to change
 * state. That keeps the Test button green without trusting unsigned input.
 */

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  try {
    const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
    // Absorb may present the signature as hex or base64; accept either.
    const candidates = [
      Buffer.from(header.trim(), "hex"),
      Buffer.from(header.trim(), "base64"),
    ];
    return candidates.some(
      (c) => c.length === expected.length && crypto.timingSafeEqual(c, expected)
    );
  } catch {
    return false;
  }
}

/** Absorb payload keys vary in casing across events; probe the usual shapes. */
function pick(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // RAW body first - required for the HMAC, and we parse from this string.
  const rawBody = await request.text();
  const signature = request.headers.get("absorb-signature");
  const userAgent = request.headers.get("user-agent") ?? "";
  const secret = process.env.SILFAB_WEBHOOK_SECRET ?? "";

  const verified = verifySignature(rawBody, signature, secret);

  let payload: Record<string, unknown> = {};
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    /* A non-JSON body is still acknowledged; it just carries nothing usable. */
  }

  const eventName =
    pick(payload, "eventName", "EventName", "event", "Event", "type") ??
    "Unknown Event";
  const userId = pick(payload, "userId", "UserId", "learnerId", "LearnerId");
  const correlationId = pick(payload, "correlationId", "CorrelationId");

  if (!verified) {
    // Acknowledged, deliberately NOT recorded - unsigned input never moves state.
    console.log(
      `[silfab-webhook] UNVERIFIED delivery accepted but ignored. event=${eventName} ` +
        `hasSignature=${!!signature} hasSecret=${!!secret} ua=${userAgent}`
    );
    return json(
      {
        received: true,
        verified: false,
        reason: secret
          ? "Signature did not match. Absorb's Test Webhook uses a random signature and cannot be validated - this is expected for a test."
          : "SILFAB_WEBHOOK_SECRET is not set on this server, so no signature could be checked.",
      },
      { status: 200 }
    );
  }

  const { duplicate, event } = recordEvent({
    event: eventName,
    userId,
    correlationId,
    verified: true,
  });

  console.log(
    `[silfab-webhook] ${duplicate ? "DUPLICATE" : "ACCEPTED"} ${eventName} ` +
      `user=${userId ?? "?"} correlation=${correlationId ?? "?"} v=${currentVersion()}`
  );

  return json({
    received: true,
    verified: true,
    duplicate,
    seq: event?.seq ?? null,
    version: currentVersion(),
  });
};

/**
 * A GET on the same URL is handy when configuring the Webhook - it proves the
 * host is reachable and shows whether the secret is configured, without
 * revealing it.
 */
export const loader = async (_args: LoaderFunctionArgs) => {
  return json({
    listener: "silfab certificate webhook",
    ready: true,
    secretConfigured: !!process.env.SILFAB_WEBHOOK_SECRET,
    version: currentVersion(),
    expects: {
      method: "POST",
      signatureHeader: "absorb-signature",
      algorithm: "HMAC-SHA256 over the raw request body",
    },
  });
};
