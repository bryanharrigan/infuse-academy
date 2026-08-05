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

// OAuth endpoints live on the TENANT PORTAL (e.g. https://bryanh.myabsorb.com),
// not on infuse.myabsorb.com. Despite the OpenAPI doc's Server field listing
// infuse.myabsorb.com, that host's /oauth/authorize is actually an API
// Gateway proxy that returns "Missing Authentication Token" — it doesn't
// serve the OAuth front-end. The tenant subdomain is correct: it returns
// proper OAuth error envelopes (e.g. invalid_client) and renders the
// hosted login page.
const OAuthBaseUrl =
  process.env.INFUSE_PORTAL_URL ?? "https://bryanh.myabsorb.com";
const ClientId = process.env.INFUSE_OAUTH_CLIENT_ID ?? "";
const ClientSecret = process.env.INFUSE_OAUTH_CLIENT_SECRET ?? "";
const PublicUrl = process.env.PUBLIC_URL ?? "https://infuse.bryanharrigan.dev";

export const RedirectUri = `${PublicUrl}/auth/callback`;

/**
 * Short-lived cookie carrying OAuth `state` values across the
 * authorize → callback round-trip, to defeat CSRF.
 *
 * It holds a LIST of recent states rather than a single value. With one
 * value, any second visit to /signin overwrites the first, so a user with
 * two tabs open — or who hits back and retries — completes login carrying
 * a state we no longer recognise and gets "OAuth state mismatch". That
 * failure mode is easy to hit and looks identical to a real problem.
 *
 * Accepting any of the last few states keeps this CSRF-safe: an attacker
 * still cannot guess a 128-bit random value, and entries expire with the
 * cookie's 10-minute Max-Age.
 */
export const oauthStateCookie = createCookie("infuse_oauth_state", {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 10, // 10 min — only needs to last the auth round-trip
  secrets: [process.env.COOKIE_SECRET ?? "dev-only-fallback-secret"],
});

/** How many concurrent in-flight sign-in attempts we tolerate. */
const MAX_TRACKED_STATES = 5;

export function newState(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Read the recent-state list, tolerating older single-string cookies. */
async function readStates(cookieHeader: string | null): Promise<string[]> {
  const parsed = await oauthStateCookie.parse(cookieHeader);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === "string");
  if (typeof parsed === "string") return [parsed]; // pre-list cookie
  return [];
}

/**
 * Build the Set-Cookie header that records `state` as in-flight,
 * preserving other recent attempts.
 */
export async function rememberState(
  cookieHeader: string | null,
  state: string
): Promise<string> {
  const existing = await readStates(cookieHeader);
  const next = [state, ...existing.filter((s) => s !== state)].slice(
    0,
    MAX_TRACKED_STATES
  );
  return oauthStateCookie.serialize(next);
}

/** True when `state` matches one of the recent in-flight attempts. */
export async function stateIsKnown(
  cookieHeader: string | null,
  state: string | null
): Promise<boolean> {
  if (!state) return false;
  return (await readStates(cookieHeader)).includes(state);
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
  return `${OAuthBaseUrl}/oauth/authorize?${params.toString()}`;
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
  const url = `${OAuthBaseUrl}/oauth/token`;
  const nonce = crypto.randomBytes(8).toString("hex");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ClientId,
    client_secret: ClientSecret,
    code,
    nonce,
    redirect_uri: RedirectUri,
  });

  // Hard 8s timeout so a hung Absorb response doesn't hold the
  // Lambda open long enough for Cloudflare to time out the whole
  // request (which would return a bare CF 502 with no diagnostics).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": ClientId,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `OAuth token exchange timed out after 8s (Absorb at ${url} didn't respond)`
      );
    }
    throw err;
  }
  clearTimeout(timeout);

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
