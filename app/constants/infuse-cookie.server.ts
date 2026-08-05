import { createCookie } from "@remix-run/node";

const COOKIE_SECRET = process.env.COOKIE_SECRET ?? "dev-only-fallback-secret";

export const infuseJwtCookie = createCookie("infuse_jwt", {
  maxAge: 60 * 60 * 6,
  httpOnly: true,
  // Required on cross-site set (the OAuth callback comes from a
  // Referer of https://bryanh.myabsorb.com). Chrome's cookie policy
  // now silently DROPS SameSite=Lax cookies set in a cross-site
  // context unless Secure is set — this was the cause of the sign-in
  // loop where the callback returned 302 → / with Set-Cookie
  // infuse_jwt=…, but the next request to / carried no cookie and
  // root loader bounced back to /signin.
  secure: true,
  sameSite: "lax",
  path: "/",
  secrets: [COOKIE_SECRET],
});
