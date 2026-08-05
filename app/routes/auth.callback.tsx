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
import { useLoaderData, Link } from "@remix-run/react";
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
    // IMPORTANT: don't return 502 here. Cloudflare intercepts 5xx
    // origin responses and swaps our JSON body for its own "Bad
    // gateway" error page, so the user never sees the actual
    // failure message. 400 keeps our JSON body intact and gives us
    // a diagnostic string on the error UI.
    return json(
      { error: `Token exchange failed — ${detail}` },
      { status: 400 }
    );
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

// The happy path always redirects, so this component only renders when
// the loader returned json({error: ...}) — state mismatch, missing code,
// OAuth provider error, or token exchange failure. Show the error string
// so we can actually see what went wrong instead of staring at a blank
// page.
export default function AuthCallback() {
  const data = useLoaderData<typeof loader>() as { error?: string } | null;
  const errorMessage = data?.error ?? "Unknown authentication error.";

  return (
    <div
      style={{
        maxWidth: 640,
        margin: "80px auto",
        padding: "32px",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(0,0,0,0.35)",
        color: "#fff",
        fontFamily:
          "'Inter', 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
        Sign-in failed
      </h1>
      <p style={{ margin: "12px 0 20px", opacity: 0.85, lineHeight: 1.5 }}>
        {errorMessage}
      </p>
      <Link
        to="/signin"
        style={{
          display: "inline-block",
          padding: "10px 18px",
          borderRadius: 8,
          background: "#6c63ff",
          color: "#fff",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        Try again
      </Link>
      <p style={{ margin: "24px 0 0", fontSize: 12, opacity: 0.55 }}>
        If this keeps happening, clear cookies for infuse.bryanharrigan.dev
        and try once more — a stale <code>infuse_oauth_state</code> from a
        prior attempt is the usual cause.
      </p>
    </div>
  );
}
