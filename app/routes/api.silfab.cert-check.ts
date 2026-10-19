import { json, LoaderFunctionArgs } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { getUserProfile, getAllAvailableCatalog, getMyCourses } from "~/.server/infuse-api";
import {
  getLearnerId,
  getCertificates,
  getEnrollmentRaw,
  nameFromEnrollment,
  idFromEnrollment,
  certificatesForCourse,
  assessCertificates,
} from "~/.server/silfab-absorb";
import { CERTIFICATIONS, findCertification, type Certification } from "~/.server/silfab-certifications";

/**
 * GET /api/silfab/cert-check?sku=<panel sku>
 *
 * Live clearance check for the Silfab Solar installer portal.
 *
 * ── What question this answers ──────────────────────────────────────
 * "Does this installer hold a VALID CERTIFICATE for the certification
 * that governs this panel series?"
 *
 * Not "did they complete the course". Completing the course is what mints
 * a certificate; the certificate is the credential. A learner who has
 * retaken a course holds several, each with its own id and expiry, and an
 * admin can expire any of them by hand without touching the enrollment.
 * So clearance is decided from the certificates collection, every time.
 *
 * ── Three outcomes, not two ─────────────────────────────────────────
 * This gates billing, so an unreadable certificate list must not render as
 * either answer:
 *
 *   cleared  - holds at least one unexpired certificate
 *   held     - holds none, or every one has lapsed / been revoked
 *   unknown  - Absorb could not be asked; `unknownReason` says why
 *
 * `billingHold` is true for both "held" and "unknown" - fail closed - but
 * the portal shows "unknown" differently, because telling an installer they
 * are uncertified when the truth is that an API call failed is its own bug.
 */

type TitleCache = {
  at: number;
  mine: Map<string, string>;
  catalog: Map<string, string>;
};
let titleCache: TitleCache | null = null;
const TITLE_TTL_MS = 60_000;

function indexCourses(payload: unknown, into: Map<string, string>): void {
  const courses =
    ((payload as { _embedded?: { courses?: unknown[] } })?._embedded?.courses as
      | Array<Record<string, unknown>>
      | undefined) ?? [];
  for (const c of courses) {
    const cid = typeof c.id === "string" ? c.id : undefined;
    const nm =
      (typeof c.name === "string" && c.name) ||
      (typeof c.title === "string" && c.title) ||
      undefined;
    if (cid && nm) into.set(cid.toLowerCase(), nm);
  }
}

export type NameSource = "enrollment" | "my-courses" | "catalog" | "unresolved";

/**
 * Resolve the certification's title from Absorb and nowhere else, so an LMS
 * rename flows through with no code change. Enrollment record first (most
 * specific), then /my-courses (where completed items live), then
 * /my-catalog. All three missing returns null - never a substitute.
 */
async function resolveTitle(
  token: string,
  id: string,
  enrollment: Record<string, unknown> | null
): Promise<{ name: string | null; source: NameSource }> {
  const fromEnrollment = nameFromEnrollment(enrollment);
  if (fromEnrollment) return { name: fromEnrollment, source: "enrollment" };

  if (!titleCache || Date.now() - titleCache.at > TITLE_TTL_MS) {
    const mine = new Map<string, string>();
    const catalog = new Map<string, string>();
    try {
      indexCourses(await getMyCourses(token, { limit: 30, showCompleted: true }), mine);
    } catch {
      /* non-fatal */
    }
    try {
      indexCourses(await getAllAvailableCatalog(token), catalog);
    } catch {
      /* non-fatal - a miss becomes "unresolved", which is reported */
    }
    titleCache = { at: Date.now(), mine, catalog };
  }

  const key = id.toLowerCase();
  const inMine = titleCache.mine.get(key);
  if (inMine) return { name: inMine, source: "my-courses" };
  const inCatalog = titleCache.catalog.get(key);
  if (inCatalog) return { name: inCatalog, source: "catalog" };
  return { name: null, source: "unresolved" };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) return json({ error: "Not authenticated" }, { status: 401 });

  const url = new URL(request.url);
  const sku = url.searchParams.get("sku");
  const series = url.searchParams.get("series");

  const cert = findCertification(sku, series);
  if (!cert) {
    return json(
      {
        error: "No certification mapped for that SKU or series",
        sku,
        series,
        knownSeries: CERTIFICATIONS.map((c: Certification) => c.series),
      },
      { status: 404 }
    );
  }

  /**
   * The enrollment is no longer the gate, but it still earns its call: it
   * carries the course title, the enrollment id that certificates may be
   * keyed on, and the progress figure shown while training is underway.
   */
  const enrollment = await getEnrollmentRaw(token, cert.id);
  const title = await resolveTitle(token, cert.id, enrollment);

  let learner = "Unknown learner";
  try {
    const profile = await getUserProfile(token);
    learner = (profile.firstName + " " + profile.lastName).trim() || learner;
  } catch {
    /* ignore - the clearance answer matters more than the name */
  }

  // ---- the actual gate: certificates held -------------------------------
  const userId = await getLearnerId(token);
  if (!userId) {
    return json(
      {
        learner,
        sku: sku ?? null,
        series: cert.series,
        certification: { id: cert.id, name: title.name, nameSource: title.source },
        clearance: "unknown",
        certified: false,
        billingHold: true,
        status: "unknown",
        certificate: null,
        unknownReason: "my-profile did not expose a learner id, so certificates cannot be read",
        checkedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const fetched = await getCertificates(token, userId);
  if (fetched.certificates === null) {
    return json(
      {
        learner,
        sku: sku ?? null,
        series: cert.series,
        certification: { id: cert.id, name: title.name, nameSource: title.source },
        clearance: "unknown",
        certified: false,
        billingHold: true,
        status: "unknown",
        certificate: null,
        unknownReason: fetched.reason ?? "certificates could not be read",
        checkedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const matched = certificatesForCourse(fetched.certificates, {
    courseId: cert.id,
    courseName: title.name,
    enrollmentId: idFromEnrollment(enrollment),
  });
  const verdict = assessCertificates(matched.matches);

  const enrollmentStatus =
    typeof enrollment?.enrollmentStatus === "string" ? enrollment.enrollmentStatus : null;
  const progress = typeof enrollment?.progress === "number" ? enrollment.progress : null;
  const completionDate =
    typeof enrollment?.completionDate === "string" ? enrollment.completionDate : null;

  return json(
    {
      learner,
      sku: sku ?? null,
      series: cert.series,
      certification: {
        id: cert.id,
        name: title.name,
        nameSource: title.source,
        ...(title.name
          ? {}
          : {
              nameNote:
                "Absorb returned no title for this id. Shown unresolved rather than substituted.",
            }),
      },

      clearance: verdict.valid ? "cleared" : "held",
      certified: verdict.valid,
      billingHold: !verdict.valid,
      status: verdict.status,

      /** The credential itself - this is what clearance is decided on. */
      certificate: verdict.certificateId || verdict.held
        ? {
            id: verdict.certificateId,
            acquiredAt: verdict.acquiredAt,
            expiresAt: verdict.expiresAt,
            daysRemaining: verdict.daysRemaining,
            neverExpires: verdict.neverExpires,
            heldForCourse: verdict.held,
            matchedOn: matched.matchedOn,
            ...(verdict.revoked ? { revoked: true } : {}),
          }
        : null,

      /** Context only. Never the gate. */
      enrollment: { status: enrollmentStatus, progress, completionDate },

      ...(fetched.partial ? { partial: fetched.reason } : {}),
      ...(matched.matchedOn === "courseName"
        ? {
            matchNote:
              "Certificates were matched on course name because no course id was present on them. Renaming the course in Absorb will break this match.",
          }
        : {}),
      recertifyUrl: verdict.valid ? null : "/api/silfab/recertify",
      checkedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
};
