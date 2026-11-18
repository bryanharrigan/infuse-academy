/**
 * app/.server/lti/ags.ts
 *
 * Assignment and Grade Services — posting a score back to the host portal.
 *
 * This is the only outbound half of the integration. The source portal
 * records everything natively because the learner plays the real Absorb
 * player with a real enrolment; the host portal knows nothing until we tell
 * it, and this is how we tell it.
 *
 * THE TWO-STEP THAT TRIPS PEOPLE UP
 * ---------------------------------
 * You cannot just POST a score. First you exchange a JWT you signed for an
 * access token, using OAuth2 client_credentials with a *client assertion*
 * rather than a client secret:
 *
 *   POST {platform.tokenUrl}
 *     grant_type=client_credentials
 *     client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
 *     client_assertion=<JWT signed with our key, verified against our JWKS>
 *     scope=https://purl.imsglobal.org/spec/lti-ags/scope/score
 *
 * Then POST the score to the line item with a very specific content type.
 * Getting the content type wrong returns a 415 that says nothing useful.
 */

import crypto from "node:crypto";

import { AGS_SCOPE } from "./claims";
import type { AgsEndpoint } from "./claims";
import { signToolJwt } from "./jwt";
import type { LtiPlatform } from "./platforms";

const SCORE_CONTENT_TYPE = "application/vnd.ims.lis.v1.score+json";

type TokenCacheEntry = { token: string; expiresAt: number };
const tokenCache = new Map<string, TokenCacheEntry>();

/**
 * Get an AGS access token for this platform, cached until shortly before it
 * expires. Platforms rate-limit the token endpoint, and a burst of webhook
 * deliveries would otherwise ask for one token per score.
 */
async function getAccessToken(platform: LtiPlatform): Promise<string> {
  const cached = tokenCache.get(platform.id);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const assertion = signToolJwt({
    iss: platform.clientId,
    sub: platform.clientId,
    aud: platform.tokenUrl,
    iat: now,
    exp: now + 300,
    jti: crypto.randomBytes(16).toString("hex"),
  });

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
    scope: AGS_SCOPE.score,
  });

  const r = await fetch(platform.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const raw = await r.text();
  if (!r.ok) {
    throw new Error(
      `AGS token request failed: ${r.status} ${raw.slice(0, 300)} ` +
        `(token endpoint ${platform.tokenUrl}). A 401 here usually means the ` +
        `platform cannot fetch or match our JWKS — check LTI_TOOL_KID.`
    );
  }
  const data = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error(`AGS token response had no access_token: ${raw.slice(0, 200)}`);
  }

  tokenCache.set(platform.id, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  });
  return data.access_token;
}

/**
 * Build the scores URL for a line item.
 *
 * The line item URL may already carry a query string — several platforms
 * include one — so `/scores` has to be inserted before it, not appended to
 * the end. Appending produces a 404 that looks like a missing line item.
 */
export function scoresUrl(lineItemUrl: string): string {
  const [path, query] = lineItemUrl.split("?");
  const base = path.replace(/\/$/, "") + "/scores";
  return query ? `${base}?${query}` : base;
}

export type ScoreInput = {
  /** The platform's user id — the LTI `sub`, not the source-portal user id. */
  ltiSub: string;
  scoreGiven: number;
  scoreMaximum: number;
  /** Shown to the learner in some platforms. Keep it short. */
  comment?: string;
};

/**
 * Report a completion to the host portal.
 *
 * Returns false (rather than throwing) when the launch simply had no AGS
 * endpoint — that is a normal configuration, not a failure: the host portal
 * admin may have added the link without a grade column. Real errors throw.
 */
export async function postScore(
  platform: LtiPlatform,
  ags: AgsEndpoint | null,
  input: ScoreInput
): Promise<boolean> {
  if (!ags?.lineitem) {
    console.warn(
      `[lti/ags] launch had no lineitem claim — nothing to report to ${platform.id}`
    );
    return false;
  }
  if (ags.scope && !ags.scope.includes(AGS_SCOPE.score)) {
    console.warn(
      `[lti/ags] platform did not grant the score scope (granted: ${ags.scope.join(", ")})`
    );
    return false;
  }

  const accessToken = await getAccessToken(platform);
  const url = scoresUrl(ags.lineitem);

  const payload = {
    userId: input.ltiSub,
    scoreGiven: input.scoreGiven,
    scoreMaximum: input.scoreMaximum,
    activityProgress: "Completed",
    gradingProgress: "FullyGraded",
    timestamp: new Date().toISOString(),
    ...(input.comment ? { comment: input.comment } : {}),
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": SCORE_CONTENT_TYPE,
    },
    body: JSON.stringify(payload),
  });
  const raw = await r.text();
  console.log(`[lti/ags] POST score → ${r.status} ${raw.slice(0, 200)} (${url})`);

  if (!r.ok) {
    throw new Error(`AGS score POST failed: ${r.status} ${raw.slice(0, 300)}`);
  }
  return true;
}
