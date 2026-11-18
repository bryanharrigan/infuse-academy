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
  apiKey: string;
  restUrl: string;
  departmentId: string;
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
  };
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
};

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

  const r = await fetch(`${cfg.restUrl}/users`, {
    method: "POST",
    headers: {
      "x-api-key": cfg.apiKey,
      "x-api-version": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await r.text();
  // Never log `body` — it carries the derived password.
  console.log(
    `[lti/portal] POST /users → ${r.status} (username=${username}) ${raw.slice(0, 200)}`
  );

  if (r.status === 401 || r.status === 403) {
    throw new Error(
      `Source portal rejected the admin call (${r.status}). The API key may ` +
        `lack Integration API user-management permission, or LTI_SOURCE_REST_URL ` +
        `points at the wrong region.`
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
  const url =
    `${cfg.restUrl}/users/${encodeURIComponent(userId)}` +
    `/enrollments/${encodeURIComponent(courseId)}?ReEnroll=${reEnroll}`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": cfg.apiKey,
      "x-api-version": "1",
      "Content-Type": "application/json",
    },
  });
  const raw = await r.text();
  console.log(`[lti/portal] admin enrol → ${r.status} ${raw.slice(0, 200)}`);

  // 409 / "already enrolled" is success for our purposes: the learner can play.
  if (r.ok || r.status === 409) return true;
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
  password: string
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
    throw new Error(`Could not authenticate as provisioned learner: ${r.status}`);
  }
  const data = JSON.parse(raw) as { token?: string };
  if (!data.token) throw new Error("authenticate returned 200 but no token");
  return data.token;
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

  const { username, password, userId } = await upsertLearner(cfg, input);
  const token = await authenticate(cfg, username, password);

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

  return { username, userId, token };
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
