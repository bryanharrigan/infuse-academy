import { redirect, LoaderFunctionArgs } from "@remix-run/node";
import { newState, rememberState } from "~/.server/infuse-oauth";
import { buildBharriganAuthorizeUrl } from "~/.server/bharrigan-oauth";

/**
 * GET /absorb-portal-sso
 *
 * Initiates the OAuth 2.0 authorization code flow for the
 * bharrigan.myabsorb.ca portal.
 *
 * 1. Generates a random CSRF state.
 * 2. Stores it in the shared oauthStateCookie (supports multiple in-flight
 *    attempts alongside the main portal's sign-in).
 * 3. Redirects to Absorb's /oauth/authorize URL.
 *
 * If the user has Google OIDC configured in the bharrigan portal (Admin →
 * SSO → Open Id Connect → Google), Absorb auto-authenticates them via their
 * active Google session — no login prompt required.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const state = newState();
  const cookieHeader = request.headers.get("Cookie");
  const stateCookieHeader = await rememberState(cookieHeader, state);

  return redirect(buildBharriganAuthorizeUrl(state), {
    headers: { "Set-Cookie": stateCookieHeader },
  });
};
