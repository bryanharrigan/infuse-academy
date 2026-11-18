/**
 * app/routes/lti.login.ts  →  GET and POST /lti/login
 *
 * OIDC third-party-initiated login. This is the first of the two requests in
 * every LTI 1.3 launch: the platform tells us who is launching and where they
 * want to end up, and we bounce the browser to the platform's own authorize
 * endpoint to collect a signed `id_token`.
 *
 * Register this URL in the host portal as the tool's "OIDC login initiation"
 * (sometimes "Login" or "Initiate login") endpoint.
 *
 * Both GET and POST are implemented because the spec permits either and
 * platforms differ. A tool that only handles one works against some LMSs and
 * mysteriously 405s against others.
 *
 * WHY THE STATE IS SERVER-SIDE AND NOT IN A COOKIE
 * ------------------------------------------------
 * The conventional implementation puts `state` in a cookie and compares it at
 * launch. That cookie has to survive a cross-site POST, so it needs
 * SameSite=None — and this tool runs inside the host portal's iframe, where
 * third-party cookies are exactly what browsers are busy blocking. A launch
 * that depends on one fails in a way that looks like a broken integration.
 *
 * So the pending `state`/`nonce` pair lives in the server-side store instead,
 * is single-use, and is high-entropy. That gives the same replay and CSRF
 * protection without depending on cookie behaviour we do not control.
 *
 * The cost: a redeploy between login and launch invalidates in-flight
 * launches. The learner relaunches and it works. See store.ts.
 */

import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";

import { ToolBaseUrl, ltiConfigured } from "~/.server/lti/keys";
import { findPlatform } from "~/.server/lti/platforms";
import { createPendingLogin } from "~/.server/lti/store";

function badRequest(message: string): Response {
  console.warn("[lti/login] rejected:", message);
  return new Response(`LTI login initiation failed: ${message}`, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function readParams(request: Request): Promise<URLSearchParams> {
  if (request.method === "POST") {
    const text = await request.text();
    return new URLSearchParams(text);
  }
  return new URL(request.url).searchParams;
}

async function handle(request: Request): Promise<Response> {
  if (!ltiConfigured()) {
    return badRequest(
      "the tool is not configured — set LTI_TOOL_PRIVATE_KEY and PUBLIC_URL"
    );
  }

  const params = await readParams(request);
  const iss = params.get("iss");
  const loginHint = params.get("login_hint");
  const clientIdParam = params.get("client_id");
  const messageHint = params.get("lti_message_hint");
  const targetLinkUri = params.get("target_link_uri");

  let platform;
  try {
    platform = findPlatform(iss, clientIdParam);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }

  if (!loginHint) {
    // Without it the platform cannot tell its authorize endpoint which user
    // this is, and the launch comes back for the wrong person or not at all.
    return badRequest("missing login_hint");
  }

  const pendingLogin = createPendingLogin(platform.id, targetLinkUri);

  const authorize = new URL(platform.authUrl);
  authorize.searchParams.set("scope", "openid");
  authorize.searchParams.set("response_type", "id_token");
  authorize.searchParams.set("response_mode", "form_post");
  // prompt=none: the learner is already authenticated on the platform. We are
  // not asking them to log in again, we are asking the platform to assert who
  // they are. Omitting this produces a visible second login in some LMSs.
  authorize.searchParams.set("prompt", "none");
  authorize.searchParams.set("client_id", platform.clientId);
  authorize.searchParams.set("redirect_uri", `${ToolBaseUrl}/lti/launch`);
  authorize.searchParams.set("login_hint", loginHint);
  authorize.searchParams.set("state", pendingLogin.state);
  authorize.searchParams.set("nonce", pendingLogin.nonce);
  if (messageHint) authorize.searchParams.set("lti_message_hint", messageHint);

  console.log(
    `[lti/login] ${platform.id} → authorize (state=${pendingLogin.state.slice(0, 8)}…)`
  );

  return redirect(authorize.href);
}

export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);
export const action = async ({ request }: ActionFunctionArgs) => handle(request);
