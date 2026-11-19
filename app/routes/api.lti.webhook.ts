/**
 * app/routes/api.lti.webhook.ts  →  POST /api/lti/webhook
 *
 * Absorb webhook receiver for the SOURCE portal. A completion here becomes a
 * score on the host portal's line item.
 *
 * Configure in the source portal: Client Settings → Webhooks → Add webhook
 *
 *   URL:    https://<this app>/api/lti/webhook
 *   Events: Enrollment Completed by Learner
 *           Enrollment Completed by Admin          (optional)
 *   Secret: copy the generated key into LTI_WEBHOOK_SECRET
 *
 * ── Signature verification ──────────────────────────────────────────
 * Absorb sends `absorb-signature`: HMAC-SHA256 over the RAW request body,
 * keyed with the webhook's secret. Recompute from `await request.text()` —
 * never from a re-serialised object, because any whitespace difference
 * changes the hash.
 *
 * ── The Test Webhook trap ───────────────────────────────────────────
 * Absorb's "Test Webhook" button sends a RANDOM signature that cannot
 * validate. A receiver that rejects bad signatures makes that button report
 * failure, which looks like a broken integration mid-demo. So: always answer
 * 200, but only ACT on verified deliveries. This mirrors the behaviour
 * already proven in api.silfab.webhook.ts.
 *
 * ── Why a webhook rather than polling ───────────────────────────────
 * The learner's browser session ends when they close the player. Nothing
 * client-side can report a completion that Absorb records afterwards, and
 * graded lesson types may complete days later. The webhook is the only
 * trigger that still works then — see store.ts for the matching limitation
 * on how long we can remember where to send it.
 */

import crypto from "node:crypto";
import { json, type ActionFunctionArgs } from "@remix-run/node";

import { postScore } from "~/.server/lti/ags";
import { allPlatforms } from "~/.server/lti/platforms";
import { findLaunchForCompletion, recordLtiEvent } from "~/.server/lti/store";

const WebhookSecret = process.env.LTI_WEBHOOK_SECRET ?? "";

function verifySignature(rawBody: string, header: string | null): boolean {
  if (!header || !WebhookSecret) return false;
  try {
    const expected = crypto
      .createHmac("sha256", WebhookSecret)
      .update(rawBody, "utf8")
      .digest();
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

function pickNumber(
  obj: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return undefined;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const rawBody = await request.text();
  const verified = verifySignature(rawBody, request.headers.get("absorb-signature"));

  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawBody);
    payload = (parsed?.payload ?? parsed?.data ?? parsed ?? {}) as Record<string, unknown>;
  } catch {
    console.warn("[lti/webhook] body was not JSON");
    return json({ received: true });
  }

  if (!verified) {
    // Acknowledged, logged, never allowed to change state.
    console.warn("[lti/webhook] UNVERIFIED delivery — acknowledged, ignored");
    recordLtiEvent(
      "webhook",
      WebhookSecret
        ? "delivery REJECTED: signature did not match LTI_WEBHOOK_SECRET " +
            "(Absorb's Test button always looks like this)"
        : "delivery REJECTED: LTI_WEBHOOK_SECRET is not set"
    );
    return json({ received: true, verified: false });
  }

  const sourceUserId = pick(payload, "userId", "UserId", "userID", "user_id");
  const sourceCourseId = pick(payload, "courseId", "CourseId", "courseID", "course_id");

  if (!sourceUserId || !sourceCourseId) {
    console.warn(
      `[lti/webhook] verified delivery with no user/course ids: ${rawBody.slice(0, 200)}`
    );
    recordLtiEvent(
      "webhook",
      `verified, but no user/course ids in payload. Keys: ${Object.keys(payload).join(", ")}`
    );
    return json({ received: true });
  }

  recordLtiEvent(
    "webhook",
    `verified completion user=${sourceUserId} course=${sourceCourseId}`
  );

  const launch = findLaunchForCompletion(sourceUserId, sourceCourseId);
  if (!launch) {
    // Normal: the learner reached this course some other way, or the record
    // aged out / was lost to a redeploy. Not an error, but worth seeing.
    console.log(
      `[lti/webhook] no launch recorded for user=${sourceUserId} course=${sourceCourseId} — nothing to report`
    );
    recordLtiEvent(
      "webhook",
      `NO MATCHING LAUNCH for course=${sourceCourseId}. The learner reached ` +
        `this course some other way, or the launch aged out / was lost to a redeploy.`
    );
    return json({ received: true, matched: false });
  }

  const platform = allPlatforms().find((p) => p.id === launch.platformId);
  if (!platform) {
    console.error(`[lti/webhook] platform ${launch.platformId} is no longer registered`);
    return json({ received: true, matched: true, posted: false });
  }

  /**
   * Absorb reports a score for scored content and nothing for content that
   * only tracks completion. Treat a completion with no score as full marks —
   * posting 0 would mark a finished course as failed in the host portal.
   *
   * The polling path (/lti/progress) resolves scores more thoroughly, by
   * reading the course enrolment and then the per-lesson records. This path
   * only sees the webhook payload, so it takes what is there. Both clamp to
   * the 0-100 range AGS expects.
   */
  const score = pickNumber(payload, "score", "Score", "scoreRaw", "ScoreRaw");
  const scoreGiven =
    typeof score === "number" ? Math.max(0, Math.min(100, score)) : 100;

  try {
    const posted = await postScore(platform, launch.ags, {
      ltiSub: launch.ltiSub,
      scoreGiven,
      scoreMaximum: 100,
      comment: launch.courseTitle ? `Completed: ${launch.courseTitle}` : undefined,
    });
    console.log(
      `[lti/webhook] completion user=${sourceUserId} course=${sourceCourseId} → posted=${posted}`
    );
    recordLtiEvent(
      "ags",
      posted
        ? `score ${scoreGiven}/100 posted to ${launch.platformId} for sub=${launch.ltiSub.slice(0, 8)}...`
        : `NOT posted — the launch carried no AGS line item, so the host ` +
            `portal gave us nowhere to send it`
    );
    return json({ received: true, matched: true, posted });
  } catch (err) {
    // Still 200: Absorb retries are not worth triggering for a platform-side
    // problem we cannot fix by being asked again immediately.
    console.error(
      "[lti/webhook] AGS post failed:",
      err instanceof Error ? err.message : err
    );
    recordLtiEvent(
      "ags",
      `POST FAILED: ${err instanceof Error ? err.message : String(err)}`
    );
    return json({ received: true, matched: true, posted: false });
  }
};

/** A GET is handy for confirming the route is deployed. */
export const loader = async () =>
  json({
    ok: true,
    route: "/api/lti/webhook",
    secretConfigured: Boolean(WebhookSecret),
  });
