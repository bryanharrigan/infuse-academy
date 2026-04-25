// Sign-in entrypoint.
//
// Replaces the old basic-auth username/password form with a 302 redirect to
// Absorb's hosted OAuth 2.0 authorize page. The user logs in there on their
// own IP (so no WAF datacenter-block), Absorb redirects to /auth/callback
// with a one-time code, and that route exchanges it for our session JWT.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  buildAuthorizeUrl,
  newState,
  oauthStateCookie,
} from "~/.server/infuse-oauth";

export const loader = async (_args: LoaderFunctionArgs) => {
  const state = newState();
  const authorizeUrl = buildAuthorizeUrl(state);
  return redirect(authorizeUrl, {
    headers: {
      "Set-Cookie": await oauthStateCookie.serialize(state),
    },
  });
};

// This component never renders — the loader always redirects. We keep it
// exported so Remix doesn't warn about a missing default export.
export default function SignIn() {
  return null;
}
