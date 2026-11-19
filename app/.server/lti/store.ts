/**
 * app/.server/lti/store.ts
 *
 * Two short-lived stores the LTI flow needs:
 *
 *   1. PENDING LOGINS — the `state` + `nonce` pair we generate at login
 *      initiation and must recognise when the launch POSTs back. Lifetime:
 *      one redirect, so minutes.
 *
 *   2. LAUNCH RECORDS — what we must remember about a launch in order to
 *      report a score back to the host portal later. Keyed by the SOURCE
 *      portal's (userId, courseId), because that is all Absorb's completion
 *      webhook gives us to match on.
 *
 * BOTH ARE IN-MEMORY, AND THAT IS A REAL LIMITATION
 * -------------------------------------------------
 * Pending logins being in-memory is fine — a redeploy mid-login just means
 * the learner relaunches.
 *
 * Launch records are different. The gap between a learner finishing a course
 * and Absorb's webhook firing can be minutes; the gap before a *graded*
 * lesson completes can be days. A redeploy in between loses the mapping and
 * the score never reaches the host portal. Nothing in this module will tell
 * you that happened — the webhook simply finds no record and logs a miss.
 *
 * For the demo this is acceptable and the failure is visible in the logs. For
 * anything beyond it, replace the two Maps below with a real store; the rest
 * of the code only touches the exported functions, so the seam is here and
 * nowhere else.
 */

import crypto from "node:crypto";

import type { AgsEndpoint } from "./claims";

const PENDING_TTL_MS = 15 * 60 * 1000;
/** Long enough for a course completed days later to still find its launch. */
const LAUNCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type PendingLogin = {
  state: string;
  nonce: string;
  platformId: string;
  /** Where the platform asked us to end up after the launch. */
  targetLinkUri: string | null;
  createdAt: number;
};

/**
 * Everything needed to provision the learner on the source portal.
 *
 * Held server-side rather than passed through the URL so no personal data
 * lands in a query string, browser history or Referer header on the way to
 * the player page.
 */
export type LaunchIdentity = {
  /** Platform issuer — half of the globally unique key for this learner. */
  iss: string;
  sub: string;
  firstName: string;
  lastName: string;
  email: string | null;
};

export type LaunchRecord = {
  launchId: string;
  platformId: string;
  /** Platform-side identity — the `userId` AGS expects in a score. */
  ltiSub: string;
  deploymentId: string | null;
  ags: AgsEndpoint | null;
  identity: LaunchIdentity;
  /** Source-portal ids, the key Absorb's webhook will match against. */
  sourceUserId: string | null;
  sourceCourseId: string;
  /** For logs and the player page heading. */
  courseTitle: string | null;
  /**
   * The learner's source-portal token, kept so the progress poll can ask
   * "are they finished yet?" without signing in again on every tick.
   * In-memory only, and it dies with the process like the rest of this store.
   */
  learnerToken: string | null;
  /** Set once a score has been accepted, so polling cannot post twice. */
  scorePosted: boolean;
  createdAt: number;
};

const pending = new Map<string, PendingLogin>();
const launches = new Map<string, LaunchRecord>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  }
  for (const [k, v] of launches) {
    if (now - v.createdAt > LAUNCH_TTL_MS) launches.delete(k);
  }
}

export function randomId(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function createPendingLogin(
  platformId: string,
  targetLinkUri: string | null
): PendingLogin {
  sweep();
  const entry: PendingLogin = {
    state: randomId(),
    nonce: randomId(),
    platformId,
    targetLinkUri,
    createdAt: Date.now(),
  };
  pending.set(entry.state, entry);
  return entry;
}

/**
 * Single use: consuming the state is what prevents a captured launch from
 * being replayed. A second POST with the same state finds nothing and is
 * rejected by the caller.
 */
export function consumePendingLogin(state: string | null): PendingLogin | null {
  if (!state) return null;
  const entry = pending.get(state) ?? null;
  if (entry) pending.delete(state);
  if (entry && Date.now() - entry.createdAt > PENDING_TTL_MS) return null;
  return entry;
}

/** Key for the webhook lookup. Source portal ids, lowercased for safety. */
function launchKey(sourceUserId: string, sourceCourseId: string): string {
  return `${sourceUserId}::${sourceCourseId}`.toLowerCase();
}

export function rememberLaunch(record: LaunchRecord): void {
  sweep();
  launches.set(record.launchId, record);
  if (record.sourceUserId) {
    launches.set(launchKey(record.sourceUserId, record.sourceCourseId), record);
  }
}

export function getLaunch(launchId: string): LaunchRecord | null {
  return launches.get(launchId) ?? null;
}

/**
 * Find the launch a completion webhook belongs to.
 *
 * Returns null when the learner reached the course some other way — a direct
 * portal login, say — which is normal and not an error. The caller logs it
 * and moves on rather than treating it as a failure.
 */
export function findLaunchForCompletion(
  sourceUserId: string,
  sourceCourseId: string
): LaunchRecord | null {
  const exact = launches.get(launchKey(sourceUserId, sourceCourseId));
  if (exact) return exact;

  /**
   * No exact match. Fall back to the most recent launch of this course.
   *
   * This covers the cases where we never learned the learner's source-portal
   * id (the profile lookup failed), and shared-learner mode, where every
   * launch resolves to the same account anyway. It is a GUESS: with more than
   * one learner in flight it can attribute a completion to the wrong person,
   * which is precisely the ambiguity shared-learner mode carries. Logged
   * loudly so a wrong score is traceable rather than mysterious.
   */
  let best: LaunchRecord | null = null;
  for (const record of launches.values()) {
    if (record.sourceCourseId !== sourceCourseId) continue;
    if (!best || record.createdAt > best.createdAt) best = record;
  }
  if (best) {
    console.warn(
      `[lti/store] no launch for user=${sourceUserId} course=${sourceCourseId}; ` +
        `falling back to the most recent launch of that course ` +
        `(sub=${best.ltiSub}). Correct for one learner at a time, a guess otherwise.`
    );
  }
  return best;
}

/** Fill in the source-portal user id once provisioning has resolved it. */
export function attachSourceUser(launchId: string, sourceUserId: string): void {
  const record = launches.get(launchId);
  if (!record) return;
  record.sourceUserId = sourceUserId;
  launches.set(launchKey(sourceUserId, record.sourceCourseId), record);
}

/** Stash the learner token so /lti/progress can poll without re-authenticating. */
export function attachLearnerToken(launchId: string, token: string): void {
  const record = launches.get(launchId);
  if (record) record.learnerToken = token;
}

/** Returns true the first time only — the caller may post a score. */
export function claimScorePost(launchId: string): boolean {
  const record = launches.get(launchId);
  if (!record || record.scorePosted) return false;
  record.scorePosted = true;
  return true;
}

/** Undo the claim when the post failed, so a later poll can retry. */
export function releaseScorePost(launchId: string): void {
  const record = launches.get(launchId);
  if (record) record.scorePosted = false;
}

export const storeStats = () => ({
  pending: pending.size,
  launches: launches.size,
});

/* ─────────────────────────── event ring buffer ─────────────────────────── */

/**
 * A short, in-memory trail of what the LTI flow has been doing.
 *
 * The origin machine's service log is not reachable from where this gets
 * debugged, which turned several failures into guesswork. This keeps the last
 * N events so `/lti/diag` can answer "what actually happened" without shell
 * access. Deliberately small and lossy -- it is a diagnostic aid, not an audit
 * log, and it dies with the process like everything else here.
 *
 * NOTHING SENSITIVE GOES IN. No tokens, no passwords, no signed JWTs.
 */
const MAX_EVENTS = 60;

export type LtiEvent = {
  at: string;
  kind: string;
  detail: string;
};

const events: LtiEvent[] = [];

export function recordLtiEvent(kind: string, detail: string): void {
  events.push({ at: new Date().toISOString(), kind, detail });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function recentLtiEvents(): LtiEvent[] {
  return [...events].reverse();
}

/** Launch summaries for /lti/diag. Identifiers truncated, nothing secret. */
export function launchSummaries(limit = 12): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const r of launches.values()) {
    if (seen.has(r.launchId)) continue;
    seen.add(r.launchId);
    out.push({
      at: new Date(r.createdAt).toISOString(),
      platform: r.platformId,
      ltiSub: r.ltiSub.slice(0, 8) + "...",
      sourceCourseId: r.sourceCourseId,
      sourceUserId: r.sourceUserId ?? null,
      courseTitle: r.courseTitle,
      // The single most common reason a completion goes nowhere.
      hasAgsLineItem: Boolean(r.ags?.lineitem),
      agsScopes: r.ags?.scope ?? [],
    });
  }
  return out
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}
