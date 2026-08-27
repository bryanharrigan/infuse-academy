import { json, LoaderFunctionArgs } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { getCurriculumChildren } from "~/.server/infuse-api";

/**
 * GET /api/psbi/curriculum/:id
 *
 * Returns the child courses inside a curriculum bundle.
 * Used by the PSBI static demo page to populate the inline player
 * lesson list with real Absorb curriculum content.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) return json({ error: "Not authenticated" }, { status: 401 });

  const { id } = params;
  if (!id) return json({ error: "id required" }, { status: 400 });

  try {
    const courses = await getCurriculumChildren(token, id);
    return json({ courses });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 500 });
  }
};
