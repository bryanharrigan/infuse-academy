/**
 * app/.server/lti/smowl.ts
 *
 * SMOWL proctoring, wrapped around the cross-portal player.
 *
 * SHAPE OF THE INTEGRATION
 * ------------------------
 * SMOWL is not an LTI tool here. It does not need to be: this app owns the
 * player page, so the proctor is embedded directly in it. That avoids the
 * whole question of whether Absorb supports LTI Proctoring Services (it does
 * not — Core, AGS and Deep Linking only) and works identically for any host
 * portal.
 *
 *   1. The learner registers their face once, at SMOWL's registration URL.
 *   2. The player page embeds SMOWL's monitoring iframe, which captures.
 *   3. That iframe posts `monitoringstatusOK` / `monitoringstatusNOTOK` to
 *      its parent. The course stays hidden until OK arrives.
 *
 * SOURCE OF TRUTH
 * ---------------
 * This file now follows SMOWL's own `jwt-smowl-examples` code samples
 * (node/index.js, php/index.php, js/index.js — all three agree), not an
 * inference from the prose guide. The two things those samples settle that
 * the guide did not:
 *
 *   • The configurable values are NOT top-level claims. They sit inside a
 *     single `data` object alongside the standard iss/aud/iat/exp.
 *   • They are SPLIT. `entityKey`, `userId`, `activity*` and `isMonitoring`
 *     travel signed, inside the token. `entityName`, `userName`, `userEmail`,
 *     `lang`, `type` and `activityUrl` travel in the query string, unsigned.
 *
 * OPTIONAL BY DESIGN
 * ------------------
 * With SMOWL_* unset, `enabled()` is false and the player page behaves exactly
 * as it did before. Proctoring must never be the reason a working demo stops
 * working.
 */

import crypto from "node:crypto";

export type SmowlConfig = {
  entityName: string;
  entityKey: string;
  apiKey: string;
  jwtSecret: string;
  audience: string;
  lang: string;
  activityType: string;
  userSalt: string;
};

/** Documented endpoints. Not configurable — they are SMOWL's own hosts. */
const MONITORING_ENDPOINT = "https://app.smowltech.net/monitor/";
const REGISTRATION_ENDPOINT = "https://swl.smowltech.net/register/";
const CM_DOWNLOAD_ENDPOINT = "https://swl.smowltech.net/monitor/SCMdownload.php";

/** Fixed by SMOWL for custom integrations. */
const ISSUER = "smowl_custom_integration";

/** Token lifetime, matching the samples' `.setExpirationTime('12h')`. */
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

/**
 * `aud` is the one value the samples leave as a placeholder:
 * `smowl_platform_domain`. It is per-entity and SMOWL supplies it with the
 * licence, so it has to be configurable. Falling back to the tool's own host
 * is the best guess available if they never say — but prefer setting
 * SMOWL_AUDIENCE to whatever they give you.
 */
function defaultAudience(): string {
  const base = process.env.LTI_TOOL_BASE_URL ?? "";
  try {
    return new URL(base).host;
  } catch {
    return "";
  }
}

export function smowlConfig(): SmowlConfig {
  return {
    entityName: process.env.SMOWL_ENTITY_NAME ?? "",
    entityKey: process.env.SMOWL_ENTITY_KEY ?? "",
    apiKey: process.env.SMOWL_API_KEY ?? "",
    jwtSecret: process.env.SMOWL_JWT_SECRET ?? "",
    audience: process.env.SMOWL_AUDIENCE || defaultAudience(),
    lang: process.env.SMOWL_LANG ?? "en",
    // SMOWL's samples document exactly two values here: `test` and `quiz`.
    // "course" is NOT one of them, which is why this is no longer hardcoded
    // at the call site.
    activityType: process.env.SMOWL_ACTIVITY_TYPE ?? "test",
    // See the note on the salt below.
    userSalt: process.env.SMOWL_USER_SALT ?? "",
  };
}

/**
 * SMOWL keys a face registration to `userId`, and there is no documented way
 * to delete one from the integration side. For a demo that needs to show the
 * registration experience more than once, that is a problem: once you have
 * registered, you can never see the first-run flow again.
 *
 * The salt solves it without touching anyone's data. Bump SMOWL_USER_SALT and
 * every learner becomes a user SMOWL has never seen, so registration replays.
 * It is append-only and reversible: set it back to a previous value and the
 * old registrations are live again.
 *
 * Leave it empty in anything resembling production. Every bump orphans the
 * previous registrations and consumes licence units afresh.
 */
function saltedUserId(cfg: SmowlConfig, userId: string): string {
  return alnum(`${userId}${cfg.userSalt}`);
}

export function enabled(cfg: SmowlConfig): boolean {
  return Boolean(cfg.entityName && cfg.entityKey && cfg.jwtSecret);
}

/* ────────────────────────────── sanitising ────────────────────────────── */

/**
 * SMOWL's rule, verbatim: "All configurable values must be alphanumeric and
 * cannot contain special characters (such as ,."'*[]()+^`_-)".
 *
 * THIS MATTERS MORE THAN IT LOOKS. Every id we would naturally pass is an
 * Absorb GUID — `6dcd9527-3d0f-469c-8753-2f28bdbc8de4` — and hyphens are on
 * that forbidden list. Passing one through unaltered is the single most
 * likely way to get a silent, hard-to-read failure out of this integration.
 *
 * Stripping the hyphens keeps the value unique and reversible-by-eye, so
 * cross-referencing a SMOWL report against an Absorb id stays easy.
 */
export function alnum(value: string): string {
  return (value ?? "").replace(/[^A-Za-z0-9]/g, "");
}

/**
 * Names and emails go in the URL, and SMOWL asks for special characters to be
 * removed — their example calls out apostrophes in names like "Sinead
 * O'connor". Accents are folded rather than dropped so names stay readable.
 */
export function cleanName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['"`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ──────────────────────────────── the JWT ─────────────────────────────── */

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The signed half of the payload. Mirrors `jwtParams` in SMOWL's samples.
 *
 * `isMonitoring` is present on a monitoring token and ABSENT on a
 * registration token — not zero, absent. That is how their samples build it.
 */
export type SmowlData = {
  entityKey: string;
  userId: string;
  activityType?: string;
  activityId?: string;
  activityContainerId?: string;
  isMonitoring?: 0 | 1;
};

/**
 * Sign a SMOWL JWT: HS256 over `{ iss, aud, iat, exp, data }`.
 *
 * The nesting under `data` is the detail that matters — flat claims are
 * rejected. Verified against node/index.js, php/index.php and js/index.js in
 * SMOWL's jwt-smowl-examples bundle, which agree on the structure.
 */
export function signSmowlToken(cfg: SmowlConfig, data: SmowlData): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: ISSUER,
    aud: cfg.audience,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    data,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createHmac("sha256", cfg.jwtSecret)
    .update(signingInput)
    .digest();
  return `${signingInput}.${b64url(signature)}`;
}

/* ────────────────────────────────── URLs ──────────────────────────────── */

export type SmowlLearner = {
  /** Absorb user id, or the LTI sub when no source-portal id is known. */
  userId: string;
  name: string;
  email: string;
};

export type SmowlActivity = {
  /** The source-portal course id. */
  activityId: string;
  /** The containing course/context id. */
  containerId: string;
  /** Where to send the learner back to once registration finishes. */
  activityUrl: string;
};

/**
 * Build a SMOWL URL.
 *
 * Parameter order is load-bearing and comes straight from their PHP sample,
 * which explicitly re-sorts the array before building the query string:
 * `token` and `entityName` are forced FIRST, the return link is forced LAST
 * (so a browser truncating a long URL loses the redirect target rather than
 * the credentials).
 *
 * BOTH `activityUrl` AND `Course_link` ARE SENT, with the same value.
 * ------------------------------------------------------------------
 * Their PHP sample re-sorts both names, which was the tell: the registration
 * flow reads `Course_link`, while the documented variable name is
 * `activityUrl`. Sending only the documented one produced a live registration
 * page whose return link was the literal string `undefined`, stranding the
 * learner at the end of the selfie flow instead of returning them to the
 * course. Sending both costs nothing and satisfies whichever one a given
 * endpoint actually reads.
 */
function buildUrl(
  base: string,
  cfg: SmowlConfig,
  token: string,
  learner: SmowlLearner,
  activityUrl?: string
): string {
  const q = new URLSearchParams();
  q.append("token", token);
  q.append("entityName", cfg.entityName);
  q.append("userName", cleanName(learner.name));
  q.append("userEmail", learner.email);
  q.append("lang", cfg.lang);
  q.append("type", "0");
  if (activityUrl) {
    q.append("activityUrl", activityUrl);
    q.append("Course_link", activityUrl);
  }
  return `${base}?${q.toString()}`;
}

export function monitoringUrl(
  cfg: SmowlConfig,
  learner: SmowlLearner,
  activity: SmowlActivity,
  isMonitoring: 0 | 1 = 1
): string {
  const token = signSmowlToken(cfg, {
    entityKey: cfg.entityKey,
    userId: saltedUserId(cfg, learner.userId),
    activityType: alnum(cfg.activityType).slice(0, 50),
    activityId: alnum(activity.activityId),
    activityContainerId: alnum(activity.containerId),
    isMonitoring,
  });
  // Their monitoring sample carries no activityUrl — the iframe is already on
  // the activity page, so there is nothing to redirect back to.
  return buildUrl(MONITORING_ENDPOINT, cfg, token, learner);
}

export function registrationUrl(
  cfg: SmowlConfig,
  learner: SmowlLearner,
  activity: SmowlActivity
): string {
  const token = signSmowlToken(cfg, {
    entityKey: cfg.entityKey,
    userId: saltedUserId(cfg, learner.userId),
    // Optional on registration, per their sample's own comments — sent anyway
    // so SMOWL can tie the enrolment to the right activity.
    activityType: alnum(cfg.activityType).slice(0, 50),
    activityId: alnum(activity.activityId),
    activityContainerId: alnum(activity.containerId),
  });
  return buildUrl(REGISTRATION_ENDPOINT, cfg, token, learner, activity.activityUrl);
}

/** Only meaningful for entities that have contracted SMOWL CM. */
export function cmDownloadUrl(cfg: SmowlConfig, userId: string): string {
  const q = new URLSearchParams({
    entity_Name: cfg.entityName,
    user_idUser: alnum(userId),
    lang: cfg.lang,
  });
  return `${CM_DOWNLOAD_ENDPOINT}?${q.toString()}`;
}

/**
 * The iframe attributes SMOWL specifies, kept here so the player page cannot
 * drift from them. The sandbox list in particular is theirs, not a guess —
 * trimming it breaks the monitoring block in ways that are hard to diagnose.
 */
export const MONITOR_IFRAME = {
  allow: "microphone; camera",
  sandbox:
    "allow-top-navigation allow-scripts allow-modals allow-same-origin " +
    "allow-popups allow-downloads allow-popups-to-escape-sandbox",
  width: 220,
  height: 300,
} as const;
