// Absorb Infuse OAuth 2.0 Authorization Code helpers.
//
// Flow:
//   1. /signin loader generates a random `state`, stores it in a short-lived
//      cookie, and 302-redirects the browser to the Absorb portal's
//      /oauth/authorize URL.
//   2. User logs in on Absorb's hosted page (their IP, no WAF block).
//   3. Absorb redirects back to /auth/callback?code=...&state=...
//   4. /auth/callback verifies the state cookie matches, then POSTs to
//      <portal>/oauth/token to exchange the code for an access_token. The
//      access_token is stored in the existing infuseJwtCookie and used as
//      a Bearer token on every subsequent Infuse API call.
//
// Env vars (all required):
//   INFUSE_PORTAL_URL           — e.g. https://bryanh.myabsorb.com
//   INFUSE_OAUTH_CLIENT_ID      — Portal Settings → Absorb Infuse Access
//   INFUSE_OAUTH_CLIENT_SECRET  — same place
//   COOKIE_SECRET               — used to sign the state cookie
//   PUBLIC_URL (optional)       — defaults to https://infuse.bryanharrigan.dev

import crypto from "node:crypto";
import { createCookie } from "@remix-run/node";

const PortalUrl =
  process.env.INFUSE_PORTAL_URL ?? "https://bryanh.myabsorb.com";
const ClientId = process.env.INFUSE_OAUTH_CLIENT_ID ?? "";
const ClientSecret = process.env.INFUSE_OAUTH_CLIENT_SECRET ?? "";
const PublicUrl = process.env.PUBLIC_URL ?? "https://infuse.bryanharrigan.dev";

export const RedirectUri = `${PublicUrl}/auth/callback`;

/**
 * Short-lived cookie that carries the OAuth `state` value across the
 * authorize → callback round-trip. Used to defeat CSRF: the callback
 * verifies the `state` query param matches what we set on signin.
 */
export const oauthStateCookie = createCookie("infuse_oauth_state", {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 10, // 10 min — only needs to last the auth round-trip
  secrets: [process.env.COOKIE_SECRET ?? "dev-only-fallback-secret"],
});

export function newState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function buildAuthorizeUrl(state: string): string {
  // Per Absorb docs the authorize endpoint takes client_id + client_secret
  // as query parameters (unusual for OAuth but documented). Scope is a
  // space-delimited string of the supported scopes.
  const params = new URLSearchParams({
    client_id: ClientId,
    client_secret: ClientSecret,
    redirect_uri: RedirectUri,
    response_type: "code",
    scope: "learner openid profile email",
    state,
  });
  return `${PortalUrl}/oauth/authorize?${params.toString()}`;
}

export type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  id_token?: string;
};

/**
 * Exchange the one-time authorization code received on the callback URL
 * for an access_token + refresh_token via the portal's /oauth/token
 * endpoint.
 *
 * Per Absorb docs:
 *   - x-api-key header carries the Client ID (yes, the same one as in body)
 *   - Body fields: grant_type, client_id, client_secret, code, nonce, redirect_uri
 *   - Body format: form-urlencoded (OAuth 2.0 standard)
 */
export async function exchangeCodeForTokens(
  code: string
): Promise<TokenResponse> {
  const url = `${PortalUrl}/oauth/token`;
  const nonce = crypto.randomBytes(8).toString("hex");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ClientId,
    client_secret: ClientSecret,
    code,
    nonce,
    redirect_uri: RedirectUri,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": ClientId,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const bodyPreview = await response
    .clone()
    .text()
    .then((t) => t.slice(0, 400))
    .catch(() => "<unreadable>");
  console.log(
    `[oauth] /oauth/token → ${response.status} (clientIdLen=${ClientId.length} secretLen=${ClientSecret.length}) body=${bodyPreview}`
  );

  if (!response.ok) {
    throw new Error(
      `OAuth token exchange failed (status=${response.status}) body=${bodyPreview}`
    );
  }
  return response.json();
}
