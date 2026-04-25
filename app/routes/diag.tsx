// Diagnostic endpoint — visible at /diag.
//
// Resource route: this file deliberately has NO default export, so Remix
// treats it as a data-only endpoint and returns the loader's JSON Response
// directly without wrapping it in an HTML page render. With a default
// export, the JSON would only be embedded in window.__remixContext__ and
// curl would receive HTML.
//
// Exposes whether each env var the app needs is set in the running Lambda.
// Reports presence + length only; never leaks secret values.

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

