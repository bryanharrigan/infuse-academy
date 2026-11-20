/**
 * app/.server/embed-provision.ts
 *
 * Creates a throwaway Absorb learner on demand so the embed can go straight
 * from "click the course" to "course is playing" with nothing asked of the
 * visitor — no sign-in, no signup form, no enrollment key.
 *
 * FLOW
 * ----
 *   POST {ABSORB_REST_URL}/users      create the learner (admin Integration API)
 *   POST {INFUSE_API_URL}/authentication   sign in as them, get a tenant JWT
 *   POST {INFUSE_BASE_URL}/my-enrollments  enrol them in the course
 *
 * The generated password exists for the length of one function call: it is
 * created, used once to authenticate, and never stored, logged or returned.
 * Only the resulting JWT leaves this module.
 *
 * WHY POST /users AND NOT THE ENROLLMENT KEY
 * ------------------------------------------
 * An enrollment key can also create accounts and auto-enrol, but redemption is
 * a portal-side form — the learner types a name and password. This path removes
 * that form entirely. It costs an admin credential that the key flow does not
 * need, which is the trade being made.
 *
 * `POST /users` is documented as "Upsert user if the username or external ID
 * matches", so a fresh random username yields a new learner and a reused one
 * returns the same learner. That is what makes session reuse below safe.
 *
 * GUARDS — read before loosening any of these
 * -------------------------------------------
 * This runs behind a page that any site can embed, so an unguarded version
 * mints an Absorb account for every page view, and for every scripted request
 * anyone cares to send. Three limits keep that bounded:
 *
 *   1. Session reuse — a visitor who already holds an embed cookie is NOT
 *      reprovisioned, so a refresh does not create a second learner. Handled
 *      by the caller (embed_.play.ts) checking the cookie first.
 *   2. Naming convention — every account is `demo-<date>-<random>` in the
 *      configured department, so cleanup is one filter and one bulk action.
 *   3. Rate cap — MAX_PER_HOUR provisions per process. Past that, callers get
 *      a clear "demo is busy" rather than an unbounded run.
 *
 * The rate cap is per server instance and resets on redeploy. It is a
 * guardrail against runaway demo traffic, not a security control. If this ever
 * stops being a sandbox, put a real one in front of it.
 */

import crypto from "node:crypto";

import { provisionAndEnrol, sourcePortal } from "./lti/portal";

import {
  InfuseBaseUrl,
  authenticate,
  startEnrollment,
} from "./infuse-api";

/**
 * The key for `POST /users`, which is the INTEGRATION API -- a different
 * product and a different key from the Infuse one.
 *
 * It is the "REST API Private Key" in Portal Settings > Info. Sending the
 * Infuse API key here returns 403, which is exactly how this was found on the
 * LTI side on 18 Nov; the fallback chain below exists so the same key does
 * not have to be entered twice under two names.
 */
const InfuseApiKey =
  process.env.EMBED_REST_API_KEY ??
  process.env.LTI_SOURCE_REST_API_KEY ??
  process.env.INFUSE_API_KEY ??
  "";

/**
 * Admin Integration API gateway — region-specific, and NOT the same host as
 * the tenant Integration API in INFUSE_BASE_URL:
 *   US  https://rest.myabsorb.com      CA  https://rest.myabsorb.ca
 *   EU  https://rest.myabsorb.eu       AU  https://rest.myabsorb.com.au
 * Pointing at the wrong region fails with an unhelpful error.
 */
const AbsorbRestUrl =
  process.env.ABSORB_REST_URL ?? process.env.LTI_SOURCE_REST_URL ?? "";

/** Department for throwaway accounts. Optional — Absorb uses its default. */
const DemoDepartmentId = process.env.EMBED_DEMO_DEPARTMENT_ID ?? "";

/** Master switch. Unset, the embed falls back to sign-in / enrollment key. */
export const autoProvisionEnabled = (): boolean =>
  process.env.EMBED_AUTO_PROVISION === "true" && Boolean(AbsorbRestUrl);

const MAX_PER_HOUR = Number(process.env.EMBED_PROVISION_MAX_PER_HOUR ?? 20);

let windowStart = Date.now();
let windowCount = 0;

function rateLimitOk(): boolean {
  const now = Date.now();
  if (now - windowStart > 60 * 60 * 1000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_HOUR) return false;
  windowCount += 1;
  return true;
}

export class ProvisionBusyError extends Error {
  constructor() {
    super(`Demo provisioning limit reached (${MAX_PER_HOUR}/hour)`);
    this.name = "ProvisionBusyError";
  }
}

/** `demo-20260915-4f2a91` — recognisable, sortable, collision-resistant. */
function generateUsername(): string {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `demo-${d}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * A password nobody ever sees. Mixed classes because Absorb portals commonly
 * enforce a complexity policy, and a rejected password surfaces as a confusing
 * 422 on user creation rather than anything about passwords.
 */
function generatePassword(): string {
  return (
    "Dx" +
    crypto.randomBytes(15).toString("base64url").replace(/[-_]/g, "") +
    "9!"
  );
}

type CreatedUser = { userId: string | null; username: string; password: string };

type LearnerOverrides = {
  username?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
};

async function createLearner(o: LearnerOverrides = {}): Promise<CreatedUser> {
  const username = o.username ?? generateUsername();
  const password = o.password ?? generatePassword();

  const base = AbsorbRestUrl.replace(/\/$/, "");
  const body: Record<string, unknown> = {
    username,
    password,
    firstName: o.firstName || "Demo",
    lastName: o.lastName || "Learner",
    isActive: true,
    /**
     * ALWAYS send an address, even a synthetic one. Absorb's user model
     * treats email as present, and omitting it is one way POST /users answers
     * with a .NET null reference rather than naming the field. example.com is
     * reserved by RFC 2606 and can never route, so a mirror learner cannot be
     * mailed by accident.
     */
    emailAddress: o.email || `${username}@example.com`,
  };
  if (DemoDepartmentId) body.departmentId = DemoDepartmentId;

  const r = await fetch(`${base}/users`, {
    method: "POST",
    headers: {
      "x-api-key": InfuseApiKey,
      "x-api-version": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await r.text();

  // Never log `body` — it carries the generated password.
  console.log(
    `[embed-provision] POST /users → ${r.status} (username=${username}) ${raw.slice(0, 200)}`
  );

  if (r.status === 401 || r.status === 403) {
    throw new Error(
      `Absorb rejected the admin call (${r.status}). INFUSE_API_KEY is probably ` +
        `an Infuse API key without Integration API user-management permission, ` +
        `or ABSORB_REST_URL points at the wrong region.`
    );
  }
  if (!r.ok) {
    throw new Error(`Could not create demo learner: ${r.status} ${raw.slice(0, 200)}`);
  }

  let userId: string | null = null;
  try {
    const parsed = JSON.parse(raw);
    userId = parsed?.id ?? parsed?.userId ?? null;
  } catch {
    // Some tenants return an empty body on success — not fatal, we only need
    // the credentials we already hold to authenticate.
  }

  return { userId, username, password };
}

export type ProvisionResult = {
  token: string;
  username: string;
  enrolled: boolean;
};

/**
 * Create a throwaway learner, sign in as them, and enrol them in `courseId`.
 *
 * Enrolment uses the learner's own `/my-enrollments` rather than an admin
 * endpoint, reusing the path the app already exercises. That means it only
 * works for courses a learner may self-enrol in — a priced course will refuse,
 * which surfaces as `enrolled: false` rather than an exception, so the caller
 * can still try to play (the learner may be entitled another way) and report
 * something useful if the mint then fails.
 */
export async function provisionDemoLearner(
  courseId: string
): Promise<ProvisionResult> {
  if (!autoProvisionEnabled()) {
    throw new Error("Auto-provisioning is not enabled");
  }
  if (!InfuseBaseUrl) {
    throw new Error("INFUSE_BASE_URL is not set");
  }
  if (!rateLimitOk()) {
    throw new ProvisionBusyError();
  }

  const { username, password } = await createLearner();

  const { token } = await authenticate(username, password);

  let enrolled = false;
  try {
    await startEnrollment(token, courseId);
    enrolled = true;
  } catch (err) {
    console.warn(
      `[embed-provision] self-enrolment failed for ${username} on ${courseId}: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }

  console.log(
    `[embed-provision] provisioned ${username} (enrolled=${enrolled}) for course ${courseId}`
  );

  return { token, username, enrolled };
}


/* ─────────────────────── launch identity (SCORM) ────────────────────────── */

/**
 * A learner identified by the launching LMS rather than by signing in.
 *
 * The SCORM runtime hands the wrapper `cmi.core.student_id` and
 * `cmi.core.student_name`, so by the time the popup opens we already know who
 * started the attempt. That removes the sign-in form entirely.
 */
export type LaunchIdentity = { sid: string; name?: string };

/**
 * ⚠️  THE TRUST BOUNDARY. READ BEFORE ENABLING.
 *
 * The identity arrives in a query string from a page we do not control and
 * cannot sign — the wrapper is client-side JavaScript served from the LMS's
 * own file host, so it can hold no secret. Anyone who can construct a URL can
 * therefore claim to be anyone.
 *
 * What that does and does not buy an attacker:
 *   - It does NOT expose the real learner's account, progress or data. The
 *     mirror is a separate account; nothing of theirs is reachable through it.
 *   - It DOES let someone play a course they were never entitled to, because
 *     we create and enrol the mirror ourselves, which bypasses the usual
 *     entitlement check.
 *   - It DOES let someone put a chosen name on a SMOWL proctoring record.
 *
 * That is the same posture EMBED_AUTO_PROVISION already carries, and it is
 * why this needs its own switch on top of it rather than riding along. Fine
 * for a demo portal; not fine the day real results depend on it. If this ever
 * stops being a sandbox, the launch has to be signed — which means a server
 * round-trip in the wrapper, not a query parameter.
 */
export const launchIdentityTrusted = (): boolean =>
  process.env.EMBED_TRUST_LAUNCH_IDENTITY === "true" && autoProvisionEnabled();

/**
 * The secret that makes the derived password stable. No fallback constant on
 * purpose: a predictable password on an account we create by admin API is a
 * far worse failure than the feature simply not working.
 */
const ProvisionSecret =
  process.env.EMBED_PROVISION_SECRET || process.env.LTI_PROVISION_SECRET || "";

/**
 * Unused since the mirror path delegated to portal.ts, which derives its own
 * stable username. Kept because the naming scheme is referenced in
 * SMOWL_SETUP.md and in the cleanup instructions for demo accounts.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function mirrorUsername(sid: string): string {
  const h = crypto.createHash("sha256").update(`scorm|${sid}`).digest("hex");
  return `scorm-${h.slice(0, 16)}`;
}

/**
 * Derived, never stored. Upsert sends the same value every time, so a repeat
 * launch re-authenticates rather than locking the learner out of their mirror.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function mirrorPassword(sid: string): string {
  const h = crypto
    .createHmac("sha256", ProvisionSecret)
    .update(`scorm|${sid}`)
    .digest("base64url");
  // Absorb wants mixed case, a digit and a symbol.
  return `Aa1!${h.slice(0, 20)}`;
}

function splitName(full: string | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  // SCORM 1.2 conventionally gives "Last, First".
  if (full && full.includes(",")) {
    const [last, first] = full.split(",", 2);
    return { firstName: (first ?? "").trim(), lastName: (last ?? "").trim() };
  }
  if (parts.length === 0) return { firstName: "Learner", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

/**
 * Create-or-reuse a stable mirror learner for an LMS-identified person, then
 * sign in as them and enrol them.
 *
 * Deliberately NOT the real learner's account: we have their id, not their
 * password, and there is no admin impersonation to borrow. The mirror plays
 * the content; the real result reaches their record through the SCORM API in
 * the wrapper. Same split as the LTI flow, where the host portal records the
 * grade and the content portal merely plays.
 *
 * Because `POST /users` upserts on username, a returning learner lands on the
 * same mirror and keeps their progress.
 */
export async function provisionMirrorLearner(
  courseId: string,
  identity: LaunchIdentity
): Promise<ProvisionResult> {
  if (!launchIdentityTrusted()) {
    throw new Error("EMBED_TRUST_LAUNCH_IDENTITY is not enabled");
  }
  if (!ProvisionSecret) {
    throw new Error(
      "Set EMBED_PROVISION_SECRET (or LTI_PROVISION_SECRET). Without it the " +
        "mirror learner's password would have to be predictable."
    );
  }
  if (!InfuseBaseUrl) throw new Error("INFUSE_BASE_URL is not set");

  const { firstName, lastName } = splitName(identity.name);

  /**
   * DELEGATED TO THE LTI PROVISIONING PATH, DELIBERATELY.
   *
   * The obvious implementation is a local createLearner + authenticate, and
   * that is what this did -- and it returned 403 every time. The Integration
   * API v2 wants `Authorization: Bearer <token>` AND `x-api-key` together;
   * sending the key alone is rejected, which reads like a permissions problem
   * on the key and is not one.
   *
   * portal.ts already handles that: adminFetch tries the key alone, escalates
   * to POST /authenticate on a 401/403, and retries with the bearer token in
   * both the raw and Bearer-prefixed forms this tenant has been seen to want.
   * Duplicating that here would mean maintaining the same escalation twice
   * and discovering the same tenant quirks twice.
   *
   * It also brings the SHARED-LEARNER FALLBACK along, which matters more than
   * the auth: with no admin credentials configured, provisionAndEnrol drops
   * back to the pre-made shared account instead of failing, so the proctored
   * popup plays rather than showing a sign-in form. Progress is shared in that
   * mode -- but SMOWL still keys on the REAL learner, because the identity is
   * passed separately, so per-learner proctoring survives a shared player.
   *
   * `iss` is the constant "scorm" so the derived username is stable per
   * learner and cannot collide with an LTI-provisioned one.
   */
  const learner = await provisionAndEnrol(sourcePortal(), {
    iss: "scorm",
    sub: identity.sid,
    firstName,
    lastName,
    email: null,
    courseId,
  });

  console.log(
    `[embed-provision] mirror ${learner.username} (mode=${learner.mode}) for course ${courseId}`
  );

  return { token: learner.token, username: learner.username, enrolled: true };
}
