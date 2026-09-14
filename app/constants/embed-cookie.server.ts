/**
 * app/constants/embed-cookie.server.ts
 *
 * Session cookie for the embeddable widget (/embed).
 *
 * WHY A SECOND COOKIE INSTEAD OF REUSING infuse_jwt
 * -------------------------------------------------
 * `infuse_jwt` is `SameSite=Lax`. Lax cookies are sent on top-level
 * navigations only — they are NOT sent for requests made from inside a
 * third-party iframe. The embed is, by definition, always in a
 * third-party iframe: some customer's page frames our /embed route.
 *
 * With Lax, the flow fails in a way that looks like a bug in our code:
 * the learner signs in, the server sets the cookie, and the very next
 * request arrives with no cookie at all, so they appear signed out
 * forever. No error, no console message.
 *
 * This cookie therefore uses:
 *
 *   SameSite=None   — sent in cross-site contexts (required for iframes)
 *   Secure          — mandatory whenever SameSite=None; browsers reject
 *                     the cookie otherwise
 *   Partitioned     — CHIPS. Chrome partitions third-party cookies by
 *                     top-level site. Without this the cookie is blocked
 *                     outright once third-party cookie deprecation lands.
 *                     With it, each embedding site gets its own isolated
 *                     jar, which is also the behaviour we want: signing in
 *                     on customer-a.com should not carry over to
 *                     customer-b.com.
 *
 * Same raw-JWT storage rationale as `infuse-cookie.server.ts`: Absorb's
 * JWT is ~2900 bytes and Remix's signed-cookie encoding inflates it past
 * the 4096-byte browser limit, at which point browsers drop it silently.
 * The JWT is self-verifying, so our own signature adds nothing.
 */

const COOKIE_NAME = "infuse_embed_jwt";
const MAX_AGE_SECONDS = 60 * 60 * 6; // 6h — matches Absorb's JWT lifetime

/** Browser hard limit per cookie. At or above this, the cookie is dropped. */
const BROWSER_COOKIE_LIMIT = 4096;

type SerializeOptions = { maxAge?: number };

export const embedJwtCookie = {
  /** Read the JWT out of a request's `Cookie` header, or null if absent. */
  async parse(cookieHeader: string | null): Promise<string | null> {
    if (!cookieHeader) return null;

    for (const part of cookieHeader.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;

      const raw = part.slice(eq + 1).trim();
      if (!raw) return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
    return null;
  },

  /** Build the `Set-Cookie` header value. Pass `{ maxAge: 0 }` to clear. */
  async serialize(value: string, options?: SerializeOptions): Promise<string> {
    const maxAge = options?.maxAge ?? MAX_AGE_SECONDS;
    const encoded = encodeURIComponent(value);

    const header = [
      `${COOKIE_NAME}=${encoded}`,
      `Max-Age=${maxAge}`,
      "Path=/embed",
      "HttpOnly",
      "Secure",
      "SameSite=None",
      "Partitioned",
    ].join("; ");

    if (header.length >= BROWSER_COOKIE_LIMIT) {
      console.error(
        `[embed-cookie] Set-Cookie is ${header.length} bytes, at or over the ` +
          `${BROWSER_COOKIE_LIMIT}-byte browser limit. Browsers will DROP this ` +
          `cookie silently and the learner will not stay signed in. ` +
          `JWT length=${value.length}.`
      );
    }

    return header;
  },
};
