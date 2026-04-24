import { createCookie } from "@remix-run/node";

const COOKIE_SECRET = process.env.COOKIE_SECRET ?? "dev-only-fallback-secret";

export const infuseJwtCookie = createCookie("infuse_jwt", {
  maxAge: 60 * 60 * 6,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secrets: [COOKIE_SECRET],
});
