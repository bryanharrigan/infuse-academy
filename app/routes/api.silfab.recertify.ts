import { json, ActionFunctionArgs } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { startEnrollment, getMyCourseEnrollment } from "~/.server/infuse-api";
import { findCertification } from "~/.server/silfab-certifications";

/**
 * POST /api/silfab/recertify
 * Body: { sku?: string, series?: string }
 *
 * Re-enrols the signed-in installer in the certificate-bearing course or
 * curriculum for that panel series, so an expired certification can be
 * earned again. The portal then opens the course in the player.
 *
 * ── Scope ───────────────────────────────────────────────────────────
 * This is the ONLY write this demo makes against the LMS, and it is
 * deliberately narrow: it enrols the caller in their own training, using
 * their own token. It cannot touch another learner, cannot grant a
 * certificate, and cannot clear a billing hold. Only completing the course
 * does that, and only Absorb decides it.
 *
 * ── A caveat worth stating plainly ──────────────────────────────────
 * Whether re-enrolling actually RESETS a completed course depends on how
 * that course is configured in Absorb (recurring / re-enrolment settings).
 * If it is not set to allow retakes, Absorb may simply leave the existing
 * completion in place. This route reports what the enrollment looked like
 * before and after so the caller can see which happened, rather than
 * assuming the reset worked.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) return json({ error: "Not authenticated" }, { status: 401 });

  let body: { sku?: string; series?: string } = {};
  try {
    body = (await request.json()) as { sku?: string; series?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const cert = findCertification(body.sku ?? null, body.series ?? null);
  if (!cert) {
    return json(
      { error: "No certification mapped for that SKU or series", sku: body.sku ?? null },
      { status: 404 }
    );
  }

  // Snapshot before, so the response can show what the re-enrolment did.
  let before: string | null = null;
  try {
    const e = await getMyCourseEnrollment(token, cert.id);
    before = e.enrollmentStatus ?? null;
  } catch {
    before = "NotEnrolled";
  }

  try {
    await startEnrollment(token, cert.id);
  } catch (err) {
    return json(
      {
        error: "Re-enrolment failed",
        detail: err instanceof Error ? err.message : String(err),
        certification: { id: cert.id },
      },
      { status: 502 }
    );
  }

  let after: string | null = null;
  try {
    const e = await getMyCourseEnrollment(token, cert.id);
    after = e.enrollmentStatus ?? null;
  } catch {
    after = null;
  }

  return json({
    ok: true,
    series: cert.series,
    // No name here on purpose: titles are resolved from Absorb by the
    // cert-check route, and this route has no business inventing one.
    certification: { id: cert.id },
    enrollmentStatus: { before, after },
    reset: before === "Complete" && after !== "Complete",
    note:
      before === "Complete" && after === "Complete"
        ? "Absorb kept the existing completion. The course may not be configured to allow retakes."
        : undefined,
  });
};
