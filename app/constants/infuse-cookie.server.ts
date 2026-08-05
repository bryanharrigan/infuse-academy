/**
 * app/constants/infuse-cookie.server.ts
 *
 * Session cookie for the Absorb tenant JWT.
 *
 * WHY THIS IS HAND-ROLLED INSTEAD OF Remix's `createCookie`
 * --------------------------------------------------------
 * Browsers enforce a hard ~4096-byte limit per cookie (name + value +
 * attributes). Over that, the cookie is silently DROPPED — no error, no
 * console message, just a small warning triangle next to the Set-Cookie
 * header in DevTools. The server thinks it logged you in; the browser
 * never stores anything; every subsequent request is unauthenticated;
 * you bounce back to /signin forever.
 *
 * Remix's `createCookie({ secrets })` inflates the value badly:
 *
 *     raw JWT                          ~2900 bytes
 *     JSON.stringify(jwt)              +2      (surrounding quotes)
 *     base64 encode                    x1.33   → ~3868
 *     + "." + HMAC-SHA256 signature    +44     → ~3912
 *     + name and attributes            +60     → ~3972  ← at the edge
 *
 * Absorb's JWT grew when their SSO 5.128 release added OIDC/JWKS claims,
 * which pushed the encoded cookie past 4096 and browsers started
 * dropping it. That is the entire bug: all browsers, all users, no
 * error message anywhere.
 *
 * Storing the JWT raw removes the base64 expansion and the signature —
 * roughly a 35% reduction — putting us comfortably back under the limit.
 *
 * Dropping Remix's signature costs us nothing. The JWT is already signed
 * by Absorb, and every request validates it against Absorb's API. A
 * tampered token fails there. Our HMAC only proved "this app issued this
 * cookie", which is redundant when the payload is self-verifying.
 *
 * The public API (`parse` / `serialize`, both async) matches Remix's
 * cookie object, so all ~18 call sites work unchanged.
 */

const COOKIE_NAME = "infuse_jwt";
const MAX_AGE_SECONDS = 60 * 60 * 6; // 6h — matches Absorb's JWT lifetime

/** Browser hard limit per cookie. Anything at or above is dropped. */
const BROWSER_COOKIE_LIMIT = 4096;

type SerializeOptions = { maxAge?: number };

export const infuseJwtCookie = {
  /**
   * Read the JWT out of a request's `Cookie` header.
   * Returns null when absent — callers treat that as "not signed in".
   */
  async parse(cookieHeader: string | null): Promise<string | null> {
    if (!cookieHeader) return null;

    for (const part of cookieHeader.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;

      const raw = part.slice(eq + 1).trim();
      if (!raw) return null;
      // JWTs only use base64url + ".", all cookie-safe, so decoding is a
      // no-op in practice. Kept so a re-encoded value still round-trips.
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
    return null;
  },

  /**
   * Build the `Set-Cookie` header value.
   * Pass `{ maxAge: 0 }` to clear the cookie (see /signout).
   *
   * Attributes:
   *   HttpOnly       — not readable from JS
   *   Secure         — required for SameSite=Lax cookies set during a
   *                    cross-site navigation (the OAuth callback arrives
   *                    with Referer: bryanh.myabsorb.com). Without it
   *                    Chrome drops the cookie.
   *   SameSite=Lax   — sent on top-level navigations, so returning from
   *                    Absorb still carries the session.
   */
  async serialize(
    value: string,
    options?: SerializeOptions
  ): Promise<string> {
    const maxAge = options?.maxAge ?? MAX_AGE_SECONDS;
    const encoded = encodeURIComponent(value);

    const header = [
      `${COOKIE_NAME}=${encoded}`,
      `Max-Age=${maxAge}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
    ].join("; ");

    // Loud warning if we're still over the limit. Without this the
    // failure mode is completely silent — which is what made the
    // original bug take so long to find. Visible in CloudWatch.
    if (header.length >= BROWSER_COOKIE_LIMIT) {
      console.error(
        `[infuse-cookie] Set-Cookie is ${header.length} bytes, at or over the ` +
          `${BROWSER_COOKIE_LIMIT}-byte browser limit. Browsers will DROP this ` +
          `cookie silently and the user will not stay signed in. ` +
          `JWT length=${value.length}.`
      );
    } else if (header.length > BROWSER_COOKIE_LIMIT * 0.85) {
      console.warn(
        `[infuse-cookie] Set-Cookie is ${header.length} bytes — within 15% of ` +
          `the ${BROWSER_COOKIE_LIMIT}-byte limit. If Absorb's JWT grows again ` +
          `this will start failing silently.`
      );
    }

    return header;
  },
};
