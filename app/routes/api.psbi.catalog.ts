import { json, LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { getAllAvailableCatalog, startEnrollment } from "~/.server/infuse-api";

/**
 * GET /api/psbi/catalog
 * Returns the learner's full catalog as JSON.
 * Used by the PSBI static demo page to render real course cards.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) return json({ error: "Not authenticated" }, { status: 401 });

  try {
    const catalog = await getAllAvailableCatalog(token);
    return json(catalog, {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 500 });
  }
};

/**
 * POST /api/psbi/catalog
 * Body: { courseId: string }
 * Enrolls the learner in a course.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) return json({ error: "Not authenticated" }, { status: 401 });

  let body: { courseId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { courseId } = body;
  if (!courseId) return json({ error: "courseId required" }, { status: 400 });

  try {
    await startEnrollment(token, courseId);
    return json({ status: "success" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 500 });
  }
};
