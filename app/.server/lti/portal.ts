/**
 * app/.server/lti/portal.ts
 *
 * A portal-scoped Absorb client for the SOURCE portal — the one that holds
 * the Online Course being played.
 *
 * WHY THIS EXISTS INSTEAD OF REUSING infuse-api.ts
 * ------------------------------------------------
 * `infuse-api.ts` reads INFUSE_BASE_URL / INFUSE_API_URL / INFUSE_API_KEY into
 * module-level constants at import time. That is correct for the single-portal
 * app and wrong for a cross-portal flow, where the host portal and the source
 * portal are different tenants with different keys and possibly different
 * regions. Refactoring 47 KB of working, load-bearing code to thread config
 * through every function is a large change with no upside for the existing
 * app, so this module reimplements only the five calls the LTI flow needs,
 * taking its config as an argument.
 *
 * The request shapes below are copied from the working implementations in
 * `infuse-api.ts` — the HMAC player challenge, the hardcoded verifier, the
 * lowercase `lessonplayer` path and its trailing empty `returnUrl=` are all
 * load-bearing quirks that were established by testing against real portals.
 * Do not "clean them up".
 *
 * CONFIGURATION
 * -------------
 * Defaults to the app's existing INFUSE_* vars so a demo works with the
 * portal you already have wired. Override per-variable to point the LTI flow
 * at a different portal than the main app uses:
 *
 *   LTI_SOURCE_BASE_URL     tenant Integration API v2  (…/api/rest/v2)
 *   LTI_SOURCE_API_URL      Infuse API host            (infuse.myabsorb.com)
 *   LTI_SOURCE_PORTAL_URL   tenant portal              (player pages live here)
 *   LTI_SOURCE_API_KEY      Infuse API key for that tenant
 *   LTI_SOURCE_REST_URL     Admin Integration API      (rest.myabsorb.com|.ca|.eu)
 *   LTI_SOURCE_DEPARTMENT_ID  department for provisioned learners
 *
 * The admin REST host is REGION-SPECIFIC and is not the same host as the
 * tenant Integration API. Pointing at the wrong region fails with an
 * unhelpful error and is the most common early mistake on this project.
 */

import crypto from "node:crypto";

export type SourcePortalConfig = {
  baseUrl: string;
  apiUrl: string;
  portalUrl: string;
  /** Infuse API key. Powers the player and the learner-scoped calls. */
  apiKey: string;
  restUrl: string;
  departmentId: string;
  /**
   * Integration API credentials -- a DIFFERENT product and a DIFFERENT key
   * from the Infuse one above. The Integration API is a paid add-on and its
   * key is the "REST API Private Key" in Portal Settings > Info. Sending the
   * Infuse key here returns 403, which is how this was found on 18 Nov.
   */
  restApiKey: string;
  /**
   * Integration API OAuth client credentials, from
   * Client Settings -> Integration API. Preferred over adminUsername /
   * adminPassword: server-to-server, no admin account, no user sign-in.
   */
  oauthClientId: string;
  oauthClientSecret: string;
  adminUsername: string;
  adminPassword: string;
  /** Fallback identity: one pre-made learner everyone plays as. */
  sharedUsername: string;
  sharedPassword: string;
};

export function sourcePortal(): SourcePortalConfig {
  const baseUrl = (
    process.env.LTI_SOURCE_BASE_URL ??
    process.env.INFUSE_BASE_URL ??
    ""
  ).replace(/\/$/, "");

  return {
    baseUrl,
    apiUrl: (
      process.env.LTI_SOURCE_API_URL ??
      process.env.INFUSE_API_URL ??
      "https://infuse.myabsorb.com"
    ).replace(/\/$/, ""),
    portalUrl: (
      process.env.LTI_SOURCE_PORTAL_URL ??
      process.env.INFUSE_PORTAL_URL ??
      baseUrl.replace(/\/api\/rest\/v2$/, "")
    ).replace(/\/$/, ""),
    apiKey: process.env.LTI_SOURCE_API_KEY ?? process.env.INFUSE_API_KEY ?? "",
    restUrl: (process.env.LTI_SOURCE_REST_URL ?? process.env.ABSORB_REST_URL ?? "")
      .replace(/\/$/, ""),
    departmentId:
      process.env.LTI_SOURCE_DEPARTMENT_ID ??
      process.env.EMBED_DEMO_DEPARTMENT_ID ??
      "",
    restApiKey: process.env.LTI_SOURCE_REST_API_KEY ?? "",
    oauthClientId: process.env.LTI_SOURCE_OAUTH_CLIENT_ID ?? "",
    oauthClientSecret: process.env.LTI_SOURCE_OAUTH_CLIENT_SECRET ?? "",
    adminUsername: process.env.LTI_SOURCE_ADMIN_USERNAME ?? "",
    adminPassword: process.env.LTI_SOURCE_ADMIN_PASSWORD ?? "",
    sharedUsername: process.env.LTI_SOURCE_LEARNER_USERNAME ?? "",
    sharedPassword: process.env.LTI_SOURCE_LEARNER_PASSWORD ?? "",
  };
}

/** Full per-learner provisioning needs all three Integration API values. */
/** True when EITHER credential shape is available. */
export function adminProvisioningConfigured(cfg: SourcePortalConfig): boolean {
  const hasCredentials =
    (cfg.oauthClientId && cfg.oauthClientSecret) ||
    (cfg.adminUsername && cfg.adminPassword);
  return Boolean(cfg.restUrl && cfg.restApiKey && hasCredentials);
}

/** The fallback needs one pre-made learner on the source portal. */
export function sharedLearnerConfigured(cfg: SourcePortalConfig): boolean {
  return Boolean(cfg.sharedUsername && cfg.sharedPassword);
}

export function assertSourcePortalConfigured(cfg: SourcePortalConfig): void {
  const missing: string[] = [];
  if (!cfg.baseUrl) missing.push("LTI_SOURCE_BASE_URL (or INFUSE_BASE_URL)");
  if (!cfg.apiKey) missing.push("LTI_SOURCE_API_KEY (or INFUSE_API_KEY)");
  if (!cfg.restUrl) missing.push("LTI_SOURCE_REST_URL (or ABSORB_REST_URL)");
  if (missing.length) {
    throw new Error(
      `Source portal is not configured — missing: ${missing.join(", ")}`
    );
  }
}

/* ───────────────────────── identity derivation ───────────────────────── */

/**
 * A username that is stable for one platform user, forever.
 *
 * `iss` + `sub` is globally unique by construction: the issuer is a URL the
 * platform owns and `sub` is unique within it. That removes the collision
 * risk a SCORM `student_id` would carry, where two customers' user "12345"
 * would silently upsert into one Absorb learner.
 *
 * Hashed rather than concatenated because Absorb usernames are capped at 255
 * characters and an issuer URL plus a GUID can approach that. The `lti-`
 * prefix keeps provisioned accounts filterable for cleanup, the same way the
 * embed's `demo-` prefix does.
 */
export function deterministicUsername(iss: string, sub: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${iss}\u0000${sub}`)
    .digest("hex")
    .slice(0, 32);
  return `lti-${digest}`;
}

/**
 * A password derived from the same identity, so every launch sends the SAME
 * value to `POST /users`.
 *
 * This sidesteps the open question about whether Absorb's upsert accepts a
 * changed password on an existing user: we never change it. The first launch
 * sets it, later launches re-send the identical string, and authentication
 * works on all of them.
 *
 * The secret must stay stable — rotating it orphans every provisioned learner
 * (the account still exists, but we can no longer sign in as it, which
 * surfaces as an authentication failure on an account that plainly exists).
 */
function derivedPassword(iss: string, sub: string): string {
  const secret =
    process.env.LTI_PROVISION_SECRET ?? process.env.COOKIE_SECRET ?? "";
  if (!secret) {
    throw new Error(
      "LTI_PROVISION_SECRET (or COOKIE_SECRET) must be set — it derives the " +
        "stable password for provisioned learners"
    );
  }
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`${iss}\u0000${sub}`)
    .digest("base64url")
    .replace(/[-_]/g, "")
    .slice(0, 24);
  // Mixed classes: Absorb portals commonly enforce a complexity policy, and a
  // rejected password surfaces as a confusing 422 on user creation rather
  // than as anything mentioning passwords.
  return `Lx${mac}9!`;
}

/* ───────────────────────────── provisioning ───────────────────────────── */

export type ProvisionedLearner = {
  username: string;
  /** Absorb user id, when the portal returned one. Needed for admin enrol. */
  userId: string | null;
  token: string;
  /**
   * "admin"  - a learner of their own, created from the launch identity.
   * "shared" - everyone played as one pre-made account. See the warning in
   *            provisionAndEnrol.
   */
  mode: "admin" | "shared";
};

/**
 * Integration API auth, with escalation.
 *
 * Absorb's docs describe two shapes and this project could not determine which
 * applies to this tenant without calling it (the sandbox's egress proxy blocks
 * rest.myabsorb.*). So: try the key alone, and only if that is refused do the
 * two-step dance. Whichever works, works, and the logs say which.
 *
 *   shape A  x-api-key alone                     (v2 style)
 *   shape B  POST /authenticate -> API token, then
 *            Authorization: <token> + x-api-key  (documented in Getting
 *            Started; the token is valid 4 hours)
 *
 * The Authorization value is sent raw first, because Absorb's own walkthrough
 * says to put the token straight in the header, then retried with a Bearer
 * prefix, because plenty of gateways want that instead.
 */
let adminToken: { value: string; expiresAt: number } | null = null;

/**
 * OAuth 2.0 client credentials grant.
 *
 *   POST {rest}/oauth/token
 *   Authorization: Basic base64(client_id:client_secret)
 *   grant_type=client_credentials
 *
 * This is the right way to do server-to-server calls against the Integration
 * API, and it is why no administrator account is needed: the token is not
 * tied to an admin user at all. Absorb's own words -- "A client credentials
 * token isn't tied to an admin user, so no admin role limits what it can do.
 * It has broad administrative access to your portal."
 *
 * That last sentence is the warning as well as the feature. The client secret
 * is as powerful as a system administrator's password and belongs in the
 * service environment, never in the repo.
 *
 * Returns "" when not configured, so the caller can fall back to the older
 * username/password path rather than failing.
 */
async function fetchClientCredentialsToken(
  cfg: SourcePortalConfig
): Promise<string> {
  if (!cfg.oauthClientId || !cfg.oauthClientSecret) return "";

  const basic = Buffer.from(
    `${cfg.oauthClientId}:${cfg.oauthClientSecret}`
  ).toString("base64");

  const r = await fetch(`${cfg.restUrl}/oauth/token`, {
    method: "POST",
    headers: {
      // Documented as "v1" for this endpoint specifically, not "2".
      "x-api-version": "v1",
      "x-api-key": cfg.restApiKey,
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const raw = await r.text();
  console.log(`[lti/portal] POST /oauth/token → ${r.status}`);
  if (!r.ok) {
    console.warn(
      `[lti/portal] client credentials failed: ${r.status} ${raw.slice(0, 200)}`
    );
    return "";
  }
  try {
    const parsed = JSON.parse(raw) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) return "";
    adminToken = {
      value: parsed.access_token,
      // Documented at 14400s. Refresh early rather than racing expiry.
      expiresAt: Date.now() + (parsed.expires_in ?? 14400) * 900,
    };
    return parsed.access_token;
  } catch {
    return "";
  }
}

async function fetchAdminToken(cfg: SourcePortalConfig): Promise<string> {
  if (adminToken && adminToken.expiresAt > Date.now()) return adminToken.value;

  // Preferred: no admin account involved.
  const ccToken = await fetchClientCredentialsToken(cfg);
  if (ccToken) return ccToken;

  if (!cfg.adminUsername || !cfg.adminPassword) {
    throw new Error(
      "No Integration API credentials. Set LTI_SOURCE_OAUTH_CLIENT_ID and " +
        "LTI_SOURCE_OAUTH_CLIENT_SECRET (Client Settings > Integration API), " +
        "or LTI_SOURCE_ADMIN_USERNAME / LTI_SOURCE_ADMIN_PASSWORD."
    );
  }

  const r = await fetch(`${cfg.restUrl}/authenticate`, {
    method: "POST",
    headers: {
      "x-api-key": cfg.restApiKey,
      "x-api-version": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: cfg.adminUsername,
      password: cfg.adminPassword,
      privateKey: cfg.restApiKey,
    }),
  });
  const raw = await r.text();
  console.log(`[lti/portal] POST /authenticate → ${r.status}`);
  if (!r.ok) {
    throw new Error(
      `Integration API /authenticate failed: ${r.status} ${raw.slice(0, 200)}`
    );
  }

  // The token comes back as a bare JSON string on some versions and wrapped on
  // others. Accept both rather than guess.
  let token = "";
  try {
    const parsed = JSON.parse(raw);
    token =
      typeof parsed === "string"
        ? parsed
        : parsed?.token ?? parsed?.accessToken ?? "";
  } catch {
    token = raw.trim().replace(/^"|"$/g, "");
  }
  if (!token) throw new Error("/authenticate returned no token");

  // Documented lifetime is 4 hours; refresh early.
  adminToken = { value: token, expiresAt: Date.now() + 3.5 * 60 * 60 * 1000 };
  return token;
}

type AdminResult = { status: number; body: string };

async function adminFetch(
  cfg: SourcePortalConfig,
  url: string,
  init: { method: string; body?: string }
): Promise<AdminResult> {
  const base: Record<string, string> = {
    "x-api-key": cfg.restApiKey || cfg.apiKey,
    "x-api-version": "1",
    "Content-Type": "application/json",
  };

  const send = async (extra: Record<string, string>) => {
    const r = await fetch(url, {
      method: init.method,
      headers: { ...base, ...extra },
      body: init.body,
    });
    return { status: r.status, body: await r.text() };
  };

  let res = await send({});
  if (res.status !== 401 && res.status !== 403) return res;

  if (!cfg.adminUsername || !cfg.adminPassword) {
    console.warn(
      `[lti/portal] ${res.status} on ${url} with the key alone, and no admin ` +
        `credentials are configured to escalate with.`
    );
    return res;
  }

  const token = await fetchAdminToken(cfg);
  console.log("[lti/portal] retrying admin call with an API token");
  res = await send({ Authorization: token });
  if (res.status === 401 || res.status === 403) {
    res = await send({ Authorization: `Bearer ${token}` });
    if (res.status < 400) console.log("[lti/portal] Bearer prefix was required");
  }
  return res;
}

type UpsertInput = {
  iss: string;
  sub: string;
  firstName: string;
  lastName: string;
  email: string | null;
};

/**
 * Create or update the learner in the source portal.
 *
 * `POST /users` is documented as "Upsert user if the username or external ID
 * matches", so a stable username makes this idempotent: first launch creates,
 * every later launch returns the same learner.
 */
async function upsertLearner(
  cfg: SourcePortalConfig,
  input: UpsertInput
): Promise<{ username: string; password: string; userId: string | null }> {
  const username = deterministicUsername(input.iss, input.sub);
  const password = derivedPassword(input.iss, input.sub);

  const body: Record<string, unknown> = {
    username,
    password,
    firstName: input.firstName,
    lastName: input.lastName,
    isActive: true,
  };
  if (input.email) body.emailAddress = input.email;
  if (cfg.departmentId) body.departmentId = cfg.departmentId;

  const res = await adminFetch(cfg, `${cfg.restUrl}/users`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const r = { ok: res.status >= 200 && res.status < 300, status: res.status };
  const raw = res.body;
  // Never log `body` — it carries the derived password.
  console.log(
    `[lti/portal] POST /users → ${r.status} (username=${username}) ${raw.slice(0, 200)}`
  );

  if (r.status === 401 || r.status === 403) {
    throw new Error(
      `Source portal rejected the admin call (${r.status}). Check, in order: ` +
        `LTI_SOURCE_REST_API_KEY is the REST API Private Key from THIS portal ` +
        `(Portal Settings > Info), not the Infuse key; the Integration API ` +
        `add-on is enabled here; LTI_SOURCE_ADMIN_USERNAME / ` +
        `LTI_SOURCE_ADMIN_PASSWORD are set if this tenant needs a token; and ` +
        `LTI_SOURCE_REST_URL matches the portal's region.`
    );
  }
  if (!r.ok) {
    throw new Error(`Could not provision learner: ${r.status} ${raw.slice(0, 200)}`);
  }

  let userId: string | null = null;
  try {
    const parsed = JSON.parse(raw);
    userId = parsed?.id ?? parsed?.userId ?? null;
  } catch {
    // Some tenants return an empty body on success. Not fatal — we fall back
    // to learner self-enrolment below when there is no id to enrol by.
  }

  return { username, password, userId };
}

/**
 * Enrol via the admin Integration API.
 *
 *   POST {rest}/users/{userId}/enrollments/{courseId}?ReEnroll={bool}
 *
 * Unlike the learner's own `/my-enrollments`, this does not care whether the
 * course permits self-enrolment, is priced, or is visible in the catalog —
 * which is exactly what syndicated content needs, since host-portal learners
 * should never be browsing the source portal's catalog at all.
 *
 * ReEnroll=false preserves an existing completion. Passing true on every
 * launch would wipe a learner's result the moment they reopened the LTI
 * object to review it.
 *
 * VERIFY THE PATH. It is taken from Absorb's generated API help index, not
 * from a spec this project has read end to end. If it 404s, check the
 * OpenAPI document on docs.myabsorb.com before changing anything else —
 * every other failure mode here looks the same from the outside.
 */
async function adminEnrol(
  cfg: SourcePortalConfig,
  userId: string,
  courseId: string,
  reEnroll = false
): Promise<boolean> {
  // `reEnroll` is lower-case r -- confirmed against the published endpoint
  // reference. The capitalised spelling this code first used is not the
  // documented parameter name.
  const url =
    `${cfg.restUrl}/users/${encodeURIComponent(userId)}` +
    `/enrollments/${encodeURIComponent(courseId)}?reEnroll=${reEnroll}`;

  const r = await adminFetch(cfg, url, { method: "POST" });
  const raw = r.body;
  console.log(`[lti/portal] admin enrol → ${r.status} ${raw.slice(0, 200)}`);

  // 409 / "already enrolled" is success for our purposes: the learner can play.
  if (r.status >= 200 && r.status < 300) return true;
  if (r.status === 409) return true;
  if (/already/i.test(raw)) return true;

  throw new Error(
    `Admin enrolment failed: ${r.status} ${raw.slice(0, 200)} (url=${url})`
  );
}

/** Learner-scoped fallback, used only when the upsert returned no user id. */
async function selfEnrol(
  cfg: SourcePortalConfig,
  token: string,
  courseId: string
): Promise<boolean> {
  const r = await fetch(`${cfg.baseUrl}/my-enrollments`, {
    method: "POST",
    headers: {
      "X-Absorb-API-Key": cfg.apiKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ courseId }),
  });
  const raw = await r.text();
  console.log(`[lti/portal] self-enrol → ${r.status} ${raw.slice(0, 160)}`);
  return r.ok || r.status === 409 || /already/i.test(raw);
}

/** Direct username/password sign-in against the source portal's Infuse API. */
async function authenticate(
  cfg: SourcePortalConfig,
  username: string,
  password: string,
  who: string
): Promise<string> {
  const r = await fetch(`${cfg.apiUrl}/authentication`, {
    method: "POST",
    headers: {
      "x-api-key": cfg.apiKey,
      "Content-Type": "application/json",
      // Retained from infuse-api.ts: Absorb's WAF has historically rejected
      // requests from cloud IP ranges with a 403 without these.
      "User-Agent": "curl/8.7.1",
      Origin: "https://infuse.bryanharrigan.dev",
      Referer: "https://infuse.bryanharrigan.dev/signin",
    },
    body: JSON.stringify({ username, password, scope: ["learner"] }),
  });
  const raw = await r.text();
  console.log(`[lti/portal] authenticate → ${r.status} ${raw.slice(0, 160)}`);
  if (!r.ok) {
    // 401 here is the source portal rejecting the username/password pair --
    // not an API-key or permission problem, which surface as 403.
    const hint =
      r.status === 401
        ? " The source portal rejected that username/password."
        : "";
    throw new Error(
      `Could not sign in as ${who} "${username}" on the source portal ` +
        `(${r.status}).${hint}`
    );
  }
  const data = JSON.parse(raw) as { token?: string };
  if (!data.token) throw new Error("authenticate returned 200 but no token");
  return data.token;
}

/**
 * Ask the source portal for the signed-in learner's own user id.
 *
 * Needed because the completion webhook identifies a learner by their
 * source-portal userId, and `store.ts` keys launches on that. Without it a
 * completion can never be matched back to the launch that caused it, and the
 * AGS score has nowhere to go.
 *
 * `POST /users` returns an id on create, but not on every tenant and never in
 * shared-learner mode (where no user is created at all). This covers both.
 * Best effort: a failure here costs AGS passback, not playback, so it warns
 * rather than throwing.
 */
async function resolveLearnerUserId(
  cfg: SourcePortalConfig,
  token: string
): Promise<string | null> {
  try {
    const r = await fetch(`${cfg.baseUrl}/my-profile`, {
      headers: {
        "X-Absorb-API-Key": cfg.apiKey,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) {
      console.warn(`[lti/portal] /my-profile → ${r.status}; no user id for AGS`);
      return null;
    }
    const data = (await r.json()) as Record<string, unknown>;
    const id = data?.id ?? data?.userId ?? data?.userID;
    if (typeof id === "string" && id) return id;
    console.warn(
      `[lti/portal] /my-profile had no id field (keys: ${Object.keys(data ?? {}).join(", ")})`
    );
    return null;
  } catch (err) {
    console.warn(
      "[lti/portal] /my-profile lookup failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Create-or-reuse the learner, enrol them, and sign in as them.
 *
 * ORDER MATTERS. Enrolment happens before the player mint, because Absorb
 * will not mint a player token for a course the learner has no enrolment in —
 * and a course in a different portal is exactly that. Doing it here means an
 * enrolment problem surfaces as an enrolment error, rather than reappearing
 * later as `Failed to get player refresh token: 403`, which is the single
 * most time-consuming misdiagnosis this project has had.
 */
export async function provisionAndEnrol(
  cfg: SourcePortalConfig,
  input: UpsertInput & { courseId: string }
): Promise<ProvisionedLearner> {
  assertSourcePortalConfigured(cfg);

  let adminFailure: string | null = null;

  if (adminProvisioningConfigured(cfg)) {
    try {
      return await provisionOwnLearner(cfg, input);
    } catch (err) {
      adminFailure = err instanceof Error ? err.message : String(err);
      if (!sharedLearnerConfigured(cfg)) throw err;
      console.warn(
        `[lti/portal] per-learner provisioning failed, falling back to the ` +
          `shared learner: ${adminFailure}`
      );
    }
  } else {
    console.log(
      "[lti/portal] Integration API not configured — using the shared learner"
    );
  }

  try {
    return await provisionSharedLearner(cfg, input.courseId);
  } catch (err) {
    const sharedFailure = err instanceof Error ? err.message : String(err);
    // Both routes failed. Showing only the second one sends you looking in the
    // wrong place, so say what each attempt did.
    throw new Error(
      adminFailure
        ? `Both routes failed.\n` +
            `Per-learner provisioning: ${adminFailure}\n` +
            `Shared learner: ${sharedFailure}`
        : sharedFailure
    );
  }
}

/** The real thing: this launch's user gets an account of their own. */
async function provisionOwnLearner(
  cfg: SourcePortalConfig,
  input: UpsertInput & { courseId: string }
): Promise<ProvisionedLearner> {
  const { username, password, userId: upsertedId } = await upsertLearner(cfg, input);
  const token = await authenticate(
    cfg,
    username,
    password,
    "the newly provisioned learner"
  );
  const userId = upsertedId ?? (await resolveLearnerUserId(cfg, token));

  if (userId) {
    await adminEnrol(cfg, userId, input.courseId);
  } else {
    console.warn(
      "[lti/portal] upsert returned no user id — falling back to self-enrolment. " +
        "This only works for courses that permit self-enrolment."
    );
    const ok = await selfEnrol(cfg, token, input.courseId);
    if (!ok) {
      throw new Error(
        "Could not enrol the learner: the source portal returned no user id " +
          "from POST /users, and self-enrolment was refused for this course."
      );
    }
  }

  console.log(`[lti/portal] provisioned ${username} for course ${input.courseId}`);
  return { username, userId, token, mode: "admin" };
}

/**
 * Fallback: play as one pre-made learner on the source portal.
 *
 * This needs no Integration API at all -- just the Infuse key and one account's
 * credentials -- so it proves cross-portal playback, framing and AGS passback
 * while the Integration API add-on is still being sorted out.
 *
 * WHAT IT GIVES UP, AND WHY IT IS DEMO-ONLY
 * -----------------------------------------
 * Every host-portal learner is the SAME person on the source portal. So their
 * progress is shared: one learner's completion marks the course complete for
 * all of them, and resuming picks up wherever the last person left off.
 *
 * It also makes the AGS mapping ambiguous. `store.ts` keys launches on
 * (sourceUserId, sourceCourseId), and here that pair is identical for everyone
 * -- so a completion webhook resolves to whichever launch was recorded most
 * recently, and the score can land on the wrong host-portal learner. Fine with
 * one tester. Not fine with two at once, and never fine in production.
 */
async function provisionSharedLearner(
  cfg: SourcePortalConfig,
  courseId: string
): Promise<ProvisionedLearner> {
  if (!sharedLearnerConfigured(cfg)) {
    throw new Error(
      "Shared-learner fallback is not configured: set " +
        "LTI_SOURCE_LEARNER_USERNAME and LTI_SOURCE_LEARNER_PASSWORD."
    );
  }

  console.warn(
    "[lti/portal] SHARED LEARNER MODE — every launch plays as " +
      `${cfg.sharedUsername}. Progress is shared and AGS attribution is ` +
      "ambiguous with more than one tester."
  );

  const token = await authenticate(
    cfg,
    cfg.sharedUsername,
    cfg.sharedPassword,
    "the shared learner"
  );

  // Best effort: the account may already be enrolled, or the course may not
  // permit self-enrolment. Either way let the mint be the real test — it fails
  // with a clear 403 if there is genuinely no entitlement.
  const enrolled = await selfEnrol(cfg, token, courseId).catch(() => false);
  if (!enrolled) {
    console.warn(
      `[lti/portal] self-enrolment did not take for ${courseId}; continuing — ` +
        "the account may already be entitled."
    );
  }

  const userId = await resolveLearnerUserId(cfg, token);

  return {
    username: cfg.sharedUsername,
    userId,
    token,
    mode: "shared",
  };
}

/* ─────────────────────────── player and catalog ─────────────────────────── */

/**
 * Absorb's player uses HMAC-SHA256 with an EMPTY key, not PKCE S256. The
 * verifier below is the constant Absorb's own reference samples ship; the
 * portal recomputes the challenge from it. Both sides must agree.
 */
const HARDCODED_PLAYER_VERIFIER = "a8f5f167f44f4964e6c998dee827110c";

function playerChallenge(verifier: string): string {
  return crypto.createHmac("sha256", "").update(verifier).digest("hex");
}

type Lesson = { id: string; isComplete?: boolean; [k: string]: unknown };
type Chapter = { _embedded?: { lessons?: Lesson[] } };

async function firstPlayableLessonId(
  cfg: SourcePortalConfig,
  token: string,
  courseId: string
): Promise<string | null> {
  try {
    const r = await fetch(`${cfg.apiUrl}/online-courses/${courseId}/chapters`, {
      headers: {
        "x-api-key": cfg.apiKey,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { _embedded?: { chapters?: Chapter[] } };
    const lessons = (data?._embedded?.chapters ?? []).flatMap(
      (c) => c._embedded?.lessons ?? []
    );
    const next = lessons.find((l) => !l.isComplete) ?? lessons[0];
    return next?.id ?? null;
  } catch {
    return null;
  }
}

export type PlayerLaunch = {
  playerUrl: string;
  lessonId: string | null;
  /** Only the lesson player frames; coursePlayer sends X-Frame-Options. */
  framable: boolean;
};

/**
 * Mint a one-time player URL on the source portal.
 *
 * The minted refresh token is SINGLE USE — every launch calls this afresh.
 * Do not cache it.
 */
export async function mintPlayerUrl(
  cfg: SourcePortalConfig,
  token: string,
  courseId: string
): Promise<PlayerLaunch> {
  const verifier = HARDCODED_PLAYER_VERIFIER;
  const lessonId = await firstPlayableLessonId(cfg, token, courseId);

  const r = await fetch(`${cfg.apiUrl}/authentication/basic-authentication-tokens`, {
    method: "POST",
    headers: {
      "x-api-key": cfg.apiKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      challenge: playerChallenge(verifier),
      claims: [{ Key: "Learner.Enrollment", Value: courseId }],
    }),
  });

  const raw = await r.text();
  console.log(`[lti/portal] player token → ${r.status} ${raw.slice(0, 200)}`);
  if (!r.ok) {
    throw new Error(
      `Failed to get player refresh token: ${r.status} ${raw.slice(0, 200)}. ` +
        `If this is a 403, the learner is not enrolled in ${courseId} on the ` +
        `source portal — check that enrolment above actually succeeded.`
    );
  }
  const data = JSON.parse(raw) as { token?: string };
  if (!data.token) throw new Error("Player token endpoint returned no token");

  const enc = encodeURIComponent;
  if (lessonId) {
    return {
      lessonId,
      framable: true,
      playerUrl:
        `${cfg.portalUrl}/learn/lessonplayer` +
        `?courseId=${courseId}` +
        `&lessonId=${lessonId}` +
        `&refreshToken=${enc(data.token)}` +
        `&verifier=${enc(verifier)}` +
        `&returnUrl=`,
    };
  }
  return {
    lessonId: null,
    framable: false,
    playerUrl:
      `${cfg.portalUrl}/learn/v2/coursePlayer` +
      `?courseId=${courseId}` +
      `&refreshToken=${enc(data.token)}` +
      `&verifier=${enc(verifier)}`,
  };
}

/* ───────────────────────────────── catalog ──────────────────────────────── */

export type SourceCourse = {
  id: string;
  name: string;
  description: string;
  courseType: string;
};

const CATALOG_PAGE_SIZE = 30;
const CATALOG_MAX_PAGES = 20;
const CATALOG_TTL_MS = 5 * 60 * 1000;

let catalogCache: { courses: SourceCourse[]; fetchedAt: number } | null = null;

function plainText(html: string | null | undefined): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * The source portal's catalog, for the deep-linking picker.
 *
 * ONLINE COURSES ONLY. Curricula are containers rather than playable content,
 * and instructor-led courses have no player at all, so offering either in the
 * picker produces a deep link that cannot play. Filtering here means the host
 * portal admin never gets to choose something broken.
 */
export async function sourceCatalog(
  cfg: SourcePortalConfig
): Promise<SourceCourse[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.courses;
  }

  const out: SourceCourse[] = [];
  for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
    const url = new URL("my-catalog", cfg.baseUrl + "/");
    url.searchParams.set("_limit", String(CATALOG_PAGE_SIZE));
    url.searchParams.set("_offset", String(page * CATALOG_PAGE_SIZE));
    url.searchParams.set("_sort", "name");
    url.searchParams.set("showCompleted", "true");

    const r = await fetch(url.href, {
      headers: {
        "X-Absorb-API-Key": cfg.apiKey,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) {
      if (page === 0) {
        throw new Error(
          `Could not read the source portal catalog: ${r.status}. Some tenants ` +
            `scope /my-catalog to an identity even with the API key present.`
        );
      }
      break;
    }
    const data = (await r.json()) as {
      _embedded?: { courses?: Record<string, unknown>[] };
    };
    const courses = data?._embedded?.courses ?? [];
    for (const c of courses) {
      if (c.courseType !== "OnlineCourse") continue;
      out.push({
        id: String(c.id),
        name: String(c.name ?? "Untitled"),
        description: plainText(c.description as string),
        courseType: "OnlineCourse",
      });
    }
    if (courses.length < CATALOG_PAGE_SIZE) break;
  }

  catalogCache = { courses: out, fetchedAt: Date.now() };
  return out;
}

/* ──────────────────────────── progress polling ─────────────────────────── */

export type CourseProgress = {
  complete: boolean;
  progress: number | null;
  status: string | null;
  completionDate: string | null;
  /** 0-100, or null when the course only tracks completion. */
  score: number | null;
  /** Where the score came from, so a surprising number is never mysterious. */
  scoreSource: "course" | "lesson" | "lessons-average" | null;
};

function numeric(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function pickScore(obj: Record<string, unknown>): number | null {
  for (const k of ["score", "Score", "scoreRaw", "grade", "percentage"]) {
    const n = numeric(obj[k]);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Scores from the per-lesson enrolment records.
 *
 * Absorb keeps the real completion data on each lesson's `enrollment` object,
 * and that is where an assessment's score lives. Used only when the course
 * enrolment itself carries no score.
 */
async function lessonScores(
  cfg: SourcePortalConfig,
  token: string,
  courseId: string
): Promise<number[]> {
  try {
    const r = await fetch(`${cfg.apiUrl}/online-courses/${courseId}/chapters`, {
      headers: {
        "x-api-key": cfg.apiKey,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) return [];
    const data = (await r.json()) as {
      _embedded?: { chapters?: Array<{ _embedded?: { lessons?: Array<Record<string, unknown>> } }> };
    };
    const lessons = (data?._embedded?.chapters ?? []).flatMap(
      (c) => c._embedded?.lessons ?? []
    );
    const scores: number[] = [];
    for (const lesson of lessons) {
      const enrolment = lesson.enrollment as Record<string, unknown> | undefined;
      if (!enrolment) continue;
      const n = pickScore(enrolment);
      if (n !== null) scores.push(n);
    }
    return scores;
  } catch {
    return [];
  }
}

/**
 * Ask the source portal whether this learner has finished the course.
 *
 * `GET {base}/my-course-enrollments/{courseId}` returns the learner's own
 * enrolment record: progress, enrollmentStatus, completionDate.
 *
 * Completion is read from three signals rather than one. Absorb's wording for
 * enrollmentStatus is not guaranteed across versions, and a course can report
 * 100% progress slightly before a completionDate lands, so any of them is
 * taken as done. Being early by a second is harmless here; missing the
 * completion entirely is not.
 */
/**
 * Per-lesson results for the playing learner.
 *
 * `lessonScores` above reduces this to a bare list of numbers because that is
 * all a single AGS score needs. SCORM has a per-object channel
 * (`cmi.objectives.n.*`) that can carry an id, a status and a score for every
 * lesson, so the detail is worth keeping rather than averaging away.
 *
 * Returns [] on any failure: a missing breakdown must never stop the overall
 * completion from being reported.
 */
export type LessonResult = {
  id: string;
  name: string;
  /** SCORM 1.2 vocabulary, so the wrapper can pass it straight through. */
  status: "completed" | "incomplete" | "passed" | "failed" | "not attempted";
  score: number | null;
};

export async function lessonResults(
  cfg: SourcePortalConfig,
  token: string,
  courseId: string
): Promise<LessonResult[]> {
  try {
    const r = await fetch(`${cfg.apiUrl}/online-courses/${courseId}/chapters`, {
      headers: {
        "x-api-key": cfg.apiKey,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) return [];
    const data = (await r.json()) as {
      _embedded?: {
        chapters?: Array<{
          _embedded?: { lessons?: Array<Record<string, unknown>> };
        }>;
      };
    };
    const lessons = (data?._embedded?.chapters ?? []).flatMap(
      (c) => c._embedded?.lessons ?? []
    );

    return lessons.map((lesson) => {
      const enrolment = lesson.enrollment as Record<string, unknown> | undefined;
      const score = enrolment ? pickScore(enrolment) : null;
      const rawStatus =
        typeof enrolment?.status === "string" ? (enrolment.status as string) : "";
      const isComplete =
        lesson.isComplete === true || /complete|passed/i.test(rawStatus);

      let status: LessonResult["status"];
      if (/fail/i.test(rawStatus)) status = "failed";
      else if (isComplete) status = score !== null ? "passed" : "completed";
      else if (enrolment) status = "incomplete";
      else status = "not attempted";

      return {
        id: typeof lesson.id === "string" ? lesson.id : "",
        name: typeof lesson.name === "string" ? lesson.name : "Lesson",
        status,
        score,
      };
    }).filter((l) => l.id);
  } catch {
    return [];
  }
}

export async function getCourseProgress(
  cfg: SourcePortalConfig,
  token: string,
  courseId: string
): Promise<CourseProgress> {
  const r = await fetch(`${cfg.baseUrl}/my-course-enrollments/${courseId}`, {
    headers: {
      "X-Absorb-API-Key": cfg.apiKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });
  if (!r.ok) {
    throw new Error(`Enrollment check failed: ${r.status}`);
  }
  const d = (await r.json()) as Record<string, unknown>;

  const progress =
    typeof d.progress === "number" ? d.progress : null;
  const status = typeof d.enrollmentStatus === "string" ? d.enrollmentStatus : null;
  const completionDate =
    typeof d.completionDate === "string" && d.completionDate
      ? d.completionDate
      : null;

  const complete =
    Boolean(completionDate) ||
    (status !== null && /complete|passed/i.test(status)) ||
    (progress !== null && progress >= 100);

  /**
   * Score resolution, most authoritative first:
   *
   *   1. the course enrolment's own score, if Absorb reports one
   *   2. a single scored lesson -- the common shape, one assessment
   *   3. the average across several scored lessons
   *
   * Null means the course tracks completion only, and the caller decides what
   * a bare completion is worth. Only looked for once the course is complete,
   * so a half-finished assessment cannot be reported as a final grade.
   */
  let score = pickScore(d);
  let scoreSource: CourseProgress["scoreSource"] = score !== null ? "course" : null;

  if (score === null && complete) {
    const scores = await lessonScores(cfg, token, courseId);
    if (scores.length === 1) {
      score = scores[0];
      scoreSource = "lesson";
    } else if (scores.length > 1) {
      score = scores.reduce((a, b) => a + b, 0) / scores.length;
      scoreSource = "lessons-average";
    }
  }

  if (score !== null) {
    // Absorb reports these as percentages. Clamp rather than trust blindly:
    // AGS rejects a scoreGiven above scoreMaximum.
    score = Math.max(0, Math.min(100, Math.round(score * 100) / 100));
  }

  return { complete, progress, status, completionDate, score, scoreSource };
}
