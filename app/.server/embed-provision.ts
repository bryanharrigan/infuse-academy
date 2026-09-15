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

import {
  InfuseBaseUrl,
  authenticate,
  startEnrollment,
} from "./infuse-api";

const InfuseApiKey = process.env.INFUSE_API_KEY ?? "";

/**
 * Admin Integration API gateway — region-specific, and NOT the same host as
 * the tenant Integration API in INFUSE_BASE_URL:
 *   US  https://rest.myabsorb.com      CA  https://rest.myabsorb.ca
 *   EU  https://rest.myabsorb.eu       AU  https://rest.myabsorb.com.au
 * Pointing at the wrong region fails with an unhelpful error.
 */
const AbsorbRestUrl = process.env.ABSORB_REST_URL ?? "";

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

async function createLearner(): Promise<CreatedUser> {
  const username = generateUsername();
  const password = generatePassword();

  const base = AbsorbRestUrl.replace(/\/$/, "");
  const body: Record<string, unknown> = {
    username,
    password,
    firstName: "Demo",
    lastName: "Learner",
    isActive: true,
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
