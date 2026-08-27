/**
 * OAuth 2.0 helpers for the bharrigan.myabsorb.ca portal.
 *
 * Mirrors infuse-oauth.ts but targets the second Absorb portal.
 * The authorize/token endpoints follow the same Absorb pattern:
 *   - client_secret is passed as a query param on /oauth/authorize
 *   - token exchange is form-urlencoded to /oauth/token with x-api-key = client_id
 *
 * Env vars required:
 *   BHARRIGAN_PORTAL_URL           e.g. https://bharrigan.myabsorb.ca
 *   BHARRIGAN_OAUTH_CLIENT_ID      Integration API → OAuth Client ID
 *   BHARRIGAN_OAUTH_CLIENT_SECRET  Integration API → OAuth Client Secret
 *   PUBLIC_URL                     your app's public origin (shared with main OAuth)
 *
 * The redirect URI registered in Absorb must be:
 *   {PUBLIC_URL}/auth/bharrigan-callback
 */

import crypto from "node:crypto";

const PORTAL =
  process.env.BHARRIGAN_PORTAL_URL ?? "https://bharrigan.myabsorb.ca";
const CLIENT_ID = process.env.BHARRIGAN_OAUTH_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.BHARRIGAN_OAUTH_CLIENT_SECRET ?? "";
const PUBLIC_URL =
  process.env.PUBLIC_URL ?? "https://infuse.bryanharrigan.dev";

export const BHARRIGAN_PORTAL = PORTAL;
export const BHARRIGAN_REDIRECT_URI = `${PUBLIC_URL}/auth/bharrigan-callback`;

/**
 * Build the Absorb OAuth authorization URL for the bharrigan portal.
 * Absorb requires client_secret on the query string (non-standard but documented).
 */
export function buildBharriganAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: BHARRIGAN_REDIRECT_URI,
    response_type: "code",
    scope: "learner openid profile email",
    state,
  });
  return `${PORTAL}/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange the one-time authorization code for an access_token.
 * We complete the exchange to establish the portal session, then
 * redirect the user to the portal — the token itself is not stored
 * (it's for the second portal, not this app).
 */
export async function exchangeBharriganCode(code: string): Promise<string> {
  const url = `${PORTAL}/oauth/token`;
  const nonce = crypto.randomBytes(8).toString("hex");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    nonce,
    redirect_uri: BHARRIGAN_REDIRECT_URI,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": CLIENT_ID,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Bharrigan token exchange failed: ${response.status} ${text.slice(0, 200)}`
    );
  }
  const data = await response.json();
  return data.access_token ?? "";
}
