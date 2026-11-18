/**
 * app/routes/lti.jwks.ts  →  GET /lti/jwks
 *
 * Our public key set. The host portal fetches this to verify the deep-linking
 * responses and AGS client assertions we sign.
 *
 * Give this URL to the host portal's LTI Registration tile as the tool's
 * public keyset / JWKS URL. Prefer it over pasting a static public key:
 * pasted keys drift from the signing key and the resulting failures are
 * silent on our side.
 */

import { json } from "@remix-run/node";

import { toolJwks } from "~/.server/lti/keys";

export const loader = async () => {
  try {
    return json(toolJwks(), {
      headers: {
        // Platforms cache this; a short max-age keeps a key rotation from
        // taking hours to propagate without hammering us on every launch.
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (err) {
    console.error("[lti/jwks]", err);
    return json(
      { error: err instanceof Error ? err.message : "JWKS unavailable" },
      { status: 500 }
    );
  }
};
