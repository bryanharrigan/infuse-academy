import { redirect, LoaderFunctionArgs } from "@remix-run/node";
import { stateIsKnown, oauthStateCookie } from "~/.server/infuse-oauth";
import {
  exchangeBharriganCode,
  BHARRIGAN_PORTAL,
} from "~/.server/bharrigan-oauth";

/**
 * GET /auth/bharrigan-callback?code=...&state=...
 *
 * OAuth 2.0 callback for the bharrigan.myabsorb.ca portal SSO.
 *
 * 1. Verifies the state param matches an in-flight state (CSRF guard).
 * 2. Exchanges the authorization code for an access_token, which completes
 *    the OAuth round-trip and establishes the learner's session on the
 *    bharrigan portal domain.
 * 3. Clears the state cookie.
 * 4. Redirects to the portal — the learner is now logged in.
 *
 * Falls back to a direct portal redirect on any error, so the learner can
 * still reach the portal and use Absorb's own login page.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieHeader = request.headers.get("Cookie");

  // Clear the state cookie regardless of outcome so it doesn't linger.
  const clearStateCookie = await oauthStateCookie.serialize("", { maxAge: 0 });

  // CSRF check
  if (!code || !(await stateIsKnown(cookieHeader, state))) {
    return redirect(BHARRIGAN_PORTAL, {
      headers: { "Set-Cookie": clearStateCookie },
    });
  }

  try {
    // Completing the exchange establishes the learner's session on the
    // bharrigan portal. The token is not stored — this app doesn't need
    // it; we just need the exchange to complete so Absorb sets its session.
    await exchangeBharriganCode(code);
  } catch (err) {
    console.warn("[bharrigan-callback] token exchange failed:", err);
    // Still redirect to portal — if Absorb set a session during /authorize,
    // the learner may already be logged in.
  }

  return redirect(BHARRIGAN_PORTAL, {
    headers: { "Set-Cookie": clearStateCookie },
  });
};
