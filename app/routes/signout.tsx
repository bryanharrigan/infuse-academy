import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";

export const loader = async (_args: LoaderFunctionArgs) => {
  const cleared = await infuseJwtCookie.serialize("", { maxAge: 0 });
  return redirect("/signin", { headers: { "Set-Cookie": cleared } });
};

export default function SignOut() {
  return null;
}
