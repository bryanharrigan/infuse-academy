/**
 * app/.server/lti/jwt.ts
 *
 * RS256 JWT sign and verify on top of node:crypto, plus a cached fetcher for
 * platform JWKS documents. No third-party JWT library — see keys.ts for why.
 *
 * SCOPE OF THE VERIFIER
 * ---------------------
 * `verifyPlatformJwt` implements exactly what LTI 1.3 requires of a tool
 * receiving an `id_token`, and nothing more:
 *
 *   - RS256 signature against the platform's published JWKS, selected by `kid`
 *   - `iss` equals the registered platform issuer
 *   - `aud` contains our `client_id`
 *   - `exp` / `iat` within a small clock skew
 *   - `nonce` matches the one we generated at login initiation (caller checks)
 *
 * It deliberately does NOT accept `alg: none`, HS256, or a key supplied in the
 * token header — all three are the classic JWT verification bypasses, and a
 * tool that accepts them will happily launch any user an attacker names.
 */

import crypto from "node:crypto";

import { ToolKeyId, toolPrivateKey } from "./keys";
import type { Jwk } from "./keys";

/** Tolerance for clock drift between us and the platform. */
const CLOCK_SKEW_S = 120;

/** How long a fetched JWKS stays cached. Platforms rotate rarely. */
const JWKS_TTL_MS = 10 * 60 * 1000;

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/** Sign a payload as an RS256 JWT with the tool's key. */
export function signToolJwt(payload: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT", kid: ToolKeyId };
  const signingInput =
    b64urlEncode(JSON.stringify(header)) +
    "." +
    b64urlEncode(JSON.stringify(payload));
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    toolPrivateKey()
  );
  return signingInput + "." + b64urlEncode(signature);
}

/** Decode without verifying. Only for reading `kid` before key selection. */
export function decodeJwtHeader(token: string): { kid?: string; alg?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT: expected 3 segments");
  try {
    return JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
  } catch {
    throw new Error("Malformed JWT: header is not JSON");
  }
}

type JwksCacheEntry = { keys: Jwk[]; fetchedAt: number };
const jwksCache = new Map<string, JwksCacheEntry>();

async function fetchJwks(jwksUrl: string): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUrl);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const r = await fetch(jwksUrl, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    // Serve a stale copy rather than failing every launch if the platform's
    // key endpoint has a blip — the keys themselves are long-lived.
    if (cached) {
      console.warn(
        `[lti/jwt] JWKS fetch failed (${r.status}) for ${jwksUrl}; using stale cache`
      );
      return cached.keys;
    }
    throw new Error(`Could not fetch platform JWKS: ${r.status} ${jwksUrl}`);
  }
  const body = (await r.json()) as { keys?: Jwk[] };
  const keys = body?.keys ?? [];
  if (keys.length === 0) {
    throw new Error(`Platform JWKS at ${jwksUrl} contained no keys`);
  }
  jwksCache.set(jwksUrl, { keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * A `kid` miss usually means the platform rotated keys since we cached.
 * Drop the cache and refetch once before giving up.
 */
async function selectKey(jwksUrl: string, kid: string | undefined): Promise<Jwk> {
  let keys = await fetchJwks(jwksUrl);
  let match = kid ? keys.find((k) => k.kid === kid) : keys[0];
  if (!match && kid) {
    jwksCache.delete(jwksUrl);
    keys = await fetchJwks(jwksUrl);
    match = keys.find((k) => k.kid === kid);
  }
  if (!match) {
    throw new Error(
      `No key with kid="${kid}" in platform JWKS ${jwksUrl} ` +
        `(available: ${keys.map((k) => k.kid).join(", ") || "none"})`
    );
  }
  return match;
}

export type VerifiedJwt = Record<string, unknown> & {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
};

/**
 * Verify a platform-issued JWT and return its claims.
 *
 * `expectedIssuer` and `expectedAudience` come from OUR registration record,
 * never from the token — checking a token against values it supplied itself
 * is not a check.
 */
export async function verifyPlatformJwt(
  token: string,
  opts: { jwksUrl: string; expectedIssuer: string; expectedAudience: string }
): Promise<VerifiedJwt> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token: expected 3 segments");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeJwtHeader(token);
  if (header.alg !== "RS256") {
    // Covers alg:none and HMAC confusion in one.
    throw new Error(`Unsupported JWT alg "${header.alg}" — only RS256 accepted`);
  }

  const jwk = await selectKey(opts.jwksUrl, header.kid);
  const publicKey = crypto.createPublicKey({
    key: jwk as crypto.JsonWebKey,
    format: "jwk",
  });

  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(headerB64 + "." + payloadB64),
    publicKey,
    b64urlDecode(sigB64)
  );
  if (!ok) throw new Error("id_token signature verification failed");

  let claims: VerifiedJwt;
  try {
    claims = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new Error("id_token payload is not JSON");
  }

  if (claims.iss !== opts.expectedIssuer) {
    throw new Error(
      `id_token iss "${claims.iss}" does not match registered platform issuer`
    );
  }

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.expectedAudience)) {
    throw new Error(
      `id_token aud does not contain our client_id "${opts.expectedAudience}"`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp + CLOCK_SKEW_S < now) {
    throw new Error("id_token has expired");
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > now) {
    throw new Error("id_token was issued in the future — check server clocks");
  }

  return claims;
}

export const jwtInternals = { b64urlEncode, b64urlDecode };
