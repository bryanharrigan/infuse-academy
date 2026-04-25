// OAuth 2.0 callback handler.
//
// Absorb redirects the user here after they sign in on /oauth/authorize:
//   GET /auth/callback?code=<one-time-code>&state=<value-we-set-in-signin>
//
// We:
//   1. Verify the `state` query param matches the value stashed in the
//      oauthStateCookie (CSRF defense).
//   2. POST the code to <portal>/oauth/token to receive an access_token +
//      refresh_token.
//   3. Store the access_token in the existing infuseJwtCookie and redirect
//      the user to /. From there the app behaves exactly as it did with
//      the basic-auth flow.
//
// The state cookie is cleared on the way out so it can't be replayed.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  exchangeCodeForTokens,
  oauthStateCookie,
} from "~/.server/infuse-oauth";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errParam = url.searchParams.get("error");
  const errDesc = url.searchParams.get("error_description");

  if (errParam) {
    return json(
      { error: `OAuth error from Absorb: ${errParam} — ${errDesc ?? "(no description)"}` },
      { status: 400 }
    );
  }
  if (!code) {
    return json({ error: "Missing authorization code" }, { status: 400 });
  }

  const cookieHeader = request.headers.get("Cookie");
  const expectedState = await oauthStateCookie.parse(cookieHeader);
  if (!state || state !== expectedState) {
    return json(
      {
        error:
          "OAuth state mismatch — possible CSRF, or your sign-in session expired. Please try again.",
      },
      { status: 400 }
    );
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return json({ error: `Token exchange failed — ${detail}` }, { status: 502 });
  }

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    await infuseJwtCookie.serialize(tokens.access_token)
  );
  // Clear the state cookie now that the round-trip is complete.
  headers.append(
    "Set-Cookie",
    await oauthStateCookie.serialize("", { maxAge: 0 })
  );

  return redirect("/", { headers });
};

// Minimal error UI for the rare cases we hit a json() above (state mismatch,
// missing code, OAuth provider returned ?error=...). The happy path always
// redirects so this only renders for failures.
export default function AuthCallback() {
  return null;
}
