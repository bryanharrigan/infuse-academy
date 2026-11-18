/**
 * app/.server/lti/keys.ts
 *
 * The tool's RSA signing key and the JWKS we publish from it.
 *
 * LTI 1.3 makes us BOTH a verifier and a signer:
 *   - we verify the platform's `id_token` against THEIR JWKS (see jwt.ts)
 *   - we sign our own JWTs (deep-linking responses, AGS client assertions)
 *     and the platform verifies them against OUR JWKS, served at /lti/jwks
 *
 * WHY NO `jose` / `jsonwebtoken` DEPENDENCY
 * -----------------------------------------
 * Node 20's `node:crypto` does RS256 sign/verify and JWK import/export
 * natively, and this repo's deploy fails outright when package.json and the
 * lockfile drift (`npm ci` refuses). Adding a dependency for ~60 lines of
 * well-specified crypto is a bad trade here. Everything below is stdlib.
 *
 * KEY MANAGEMENT
 * --------------
 * The private key lives in `LTI_TOOL_PRIVATE_KEY` as a PKCS#8 PEM. Generate:
 *
 *   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
 *     -out lti-private.pem
 *
 * Then paste it into the env var with literal \n escapes, or set it with real
 * newlines if your host allows them — `normalisePem` below accepts both,
 * because getting this wrong produces an opaque "unsupported" error from
 * createPrivateKey that says nothing about formatting.
 *
 * The key MUST be stable across deploys. Rotating it invalidates every
 * platform registration that cached our JWKS, which presents as deep links
 * silently failing to save.
 */

import crypto from "node:crypto";

const RawPrivateKey = process.env.LTI_TOOL_PRIVATE_KEY ?? "";

/**
 * `kid` published in our JWKS and set in the header of everything we sign.
 * Any stable string works; platforms use it only to select the right key.
 */
export const ToolKeyId = process.env.LTI_TOOL_KID ?? "infuse-lti-1";

/** Public base URL of this app, e.g. https://infuse.bryanharrigan.dev */
export const ToolBaseUrl = (
  process.env.PUBLIC_URL ??
  process.env.LTI_TOOL_BASE_URL ??
  ""
).replace(/\/$/, "");

/**
 * Env vars commonly arrive with `\n` as two literal characters. A PEM with
 * literal backslash-n is not a PEM, and createPrivateKey's error message for
 * that case is unhelpful, so normalise before parsing.
 */
function normalisePem(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

let cachedPrivateKey: crypto.KeyObject | null = null;

export function ltiConfigured(): boolean {
  return Boolean(RawPrivateKey && ToolBaseUrl);
}

export function toolPrivateKey(): crypto.KeyObject {
  if (cachedPrivateKey) return cachedPrivateKey;
  if (!RawPrivateKey) {
    throw new Error(
      "LTI_TOOL_PRIVATE_KEY is not set. Generate one with: " +
        "openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out lti-private.pem"
    );
  }
  try {
    cachedPrivateKey = crypto.createPrivateKey(normalisePem(RawPrivateKey));
  } catch (err) {
    throw new Error(
      "LTI_TOOL_PRIVATE_KEY could not be parsed as a PEM private key. " +
        "Check for literal \\n escapes or a truncated value. " +
        (err instanceof Error ? err.message : String(err))
    );
  }
  return cachedPrivateKey;
}

export type Jwk = {
  kty: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
};

/**
 * Our public key as a JWKS, for GET /lti/jwks.
 *
 * Derived from the private key rather than configured separately — one source
 * of truth means the published key can never drift from the signing key,
 * which is a failure mode that looks like "the platform rejects everything we
 * sign" and takes a long time to spot.
 */
export function toolJwks(): { keys: Jwk[] } {
  const pub = crypto.createPublicKey(toolPrivateKey());
  const jwk = pub.export({ format: "jwk" }) as Jwk;
  return {
    keys: [{ ...jwk, kid: ToolKeyId, alg: "RS256", use: "sig" }],
  };
}
