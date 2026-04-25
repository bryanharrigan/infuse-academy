// Diagnostic endpoint — visible at /__diag.
//
// Exposes whether each env var the app needs is set in the running Lambda.
// Reports presence + length only; never leaks secret values. Helpful when
// you've added env vars in the Amplify console but the redeploy doesn't
// seem to have picked them up.
//
// Safe to leave deployed: no secret values are returned.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

const ENV_VARS = [
  "NODE_ENV",
  "PORT",
  "PUBLIC_URL",
  "COOKIE_SECRET",
  "INFUSE_API_KEY",
  "INFUSE_API_URL",
  "INFUSE_BASE_URL",
  "INFUSE_PORTAL_URL",
  "INFUSE_OAUTH_CLIENT_ID",
  "INFUSE_OAUTH_CLIENT_SECRET",
] as const;

export const loader = async (_args: LoaderFunctionArgs) => {
  const env: Record<string, string> = {};
  for (const name of ENV_VARS) {
    const v = process.env[name];
    if (v == null) {
      env[name] = "UNSET";
    } else if (v === "") {
      env[name] = "EMPTY";
    } else {
      // Show length and first/last 2 chars so you can confirm it's the
      // value you expect without leaking the secret.
      env[name] = `present(len=${v.length}, ${v.slice(0, 2)}…${v.slice(-2)})`;
    }
  }
  return json({
    node: process.version,
    cwd: process.cwd(),
    env,
    ts: new Date().toISOString(),
  });
};

export default function Diag() {
  return null;
}
