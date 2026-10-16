import { json, LoaderFunctionArgs } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import {
  getMyCourseEnrollment,
  getUserProfile,
  getAllAvailableCatalog,
  getMyCourses,
} from "~/.server/infuse-api";
import {
  lookupCertificateExpiry,
  getEnrollmentRaw,
  nameFromEnrollment,
} from "~/.server/silfab-absorb";
import {
  CERTIFICATIONS,
  findCertification,
  resolveExpiry,
  type Certification,
} from "~/.server/silfab-certifications";

/**
 * GET /api/silfab/cert-check?sku=<panel sku>
 *
 * Live certification check for the Silfab Solar installer-portal demo.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 * In the Silfab model, an installer cannot close and bill a work order
 * unless they hold an active certification for that panel's series.
 * Their CRM makes exactly this call and refuses the job when the answer
 * is negative.
 *
 * ── How a certification is modelled ─────────────────────────────────
 * In Absorb, a certification is ANY course or curriculum with
 * "Certificate" enabled — the certificate is awarded on completion.
 * So the check reduces to: is the certificate-bearing course/curriculum
 * complete for this learner?
 *
 * `my-course-enrollments/{id}` answers that for either a course or a
 * curriculum, which is why one call covers both shapes.
 *
 * ── Where the mapping lives ─────────────────────────────────────────
 * The Absorb API does not expose the "has Certificate enabled" flag, so
 * SKU → certification is configuration rather than discovery. That is
 * faithful to the real architecture: Absorb owns the completion truth,
 * the channel/CRM system owns which product requires which credential.
 * Swap the IDs in CERTIFICATIONS to repoint the demo.
 */

/**
 * Resolve a certification's display title from Absorb, so renaming the
 * course or curriculum in the LMS shows up in the portal with no code
 * change.
 *
 * ┌─ Why this is three lookups and not one ─────────────────────────┐
 * │ The first version read /my-catalog only, which is the list of     │
 * │ things the learner can ENROL IN. A certification the learner has  │
 * │ already completed is normally not in it - it has moved to         │
 * │ /my-courses. So for exactly the learner this demo is about, the    │
 * │ lookup missed every time and the route quietly served a           │
 * │ hard-coded title instead. That is the bug this replaces.          │
 * └────────────────────────────────────────────────────────┘
 *
 * Order, cheapest and most specific first:
 *   1. the enrollment record for this exact course, if it carries a name
 *   2. /my-courses  - where enrolled and completed items live
 *   3. /my-catalog  - where not-yet-enrolled items live
 *
 * If all three miss, the answer is `null` with source "unresolved". The
 * route does NOT substitute a plausible title: the portal renders the
 * failure instead, because an invented course name that reads like a real
 * one is worse than an obvious gap.
 *
 * The two list lookups are cached briefly in-process - clicking between
 * work orders would otherwise re-walk the catalogue on every check.
 */
type TitleCache = {
  at: number;
  /** Titles from /my-courses - enrolled and completed. */
  mine: Map<string, string>;
  /** Titles from /my-catalog - still enrollable. */
  catalog: Map<string, string>;
};
let titleCache: TitleCache | null = null;
const TITLE_TTL_MS = 60_000;

/** Fold an Absorb course list into id -> name. */
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

async function resolveTitle(
  token: string,
  id: string
): Promise<{ name: string | null; source: NameSource }> {
  // 1. The enrollment record for this course, if Absorb puts a name on it.
  const fromEnrollment = nameFromEnrollment(await getEnrollmentRaw(token, id));
  if (fromEnrollment) return { name: fromEnrollment, source: "enrollment" };

  // 2 + 3. The learner's own course lists, built once and cached.
  // Kept as two maps so the response can say which list answered.
  if (!titleCache || Date.now() - titleCache.at > TITLE_TTL_MS) {
    const mine = new Map<string, string>();
    const catalog = new Map<string, string>();

    // Enrolled and completed items. showCompleted matters: the whole point
    // is to find a certification the learner has already finished.
    try {
      indexCourses(await getMyCourses(token, { limit: 30, showCompleted: true }), mine);
    } catch {
      /* non-fatal - fall through to the catalogue */
    }

    // Everything still enrollable.
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

  // Title straight from Absorb, so LMS renames show up here automatically.
  // `name` is null when Absorb could not be asked or did not know - the
  // portal renders that as a visible gap rather than a made-up title.
  const title = await resolveTitle(token, cert.id);

  // Learner identity is nice-to-have for the demo panel, never fatal.
  let learner = "Unknown learner";
  try {
    const profile = await getUserProfile(token);
    learner = `${profile.firstName} ${profile.lastName}`.trim() || learner;
  } catch {
    /* ignore — the certification answer matters more than the name */
  }

  /**
   * getMyCourseEnrollment throws on any non-200, and a learner who was
   * never enrolled is exactly that case. That is NOT an error here — it
   * is the interesting answer: no enrollment means no completion means
   * no certificate means the work order is held. Treat it as such.
   */
  let enrollmentStatus: string | null = null;
  let completionDate: string | null = null;
  let progress: number | null = null;
  let enrolled = true;
  let lookupNote: string | undefined;

  try {
    const e = await getMyCourseEnrollment(token, cert.id);
    enrollmentStatus = e.enrollmentStatus ?? null;
    completionDate = e.completionDate ?? null;
    progress = typeof e.progress === "number" ? e.progress : null;
  } catch (err) {
    enrolled = false;
    lookupNote =
      "No enrollment record for this learner on the certification — treated as not certified.";
    if (process.env.NODE_ENV !== "production") {
      lookupNote += ` (${err instanceof Error ? err.message : String(err)})`;
    }
  }

  const completed =
    enrolled &&
    (String(enrollmentStatus).toLowerCase() === "complete" || !!completionDate);

  /**
   * Expiry is checked only once the item is complete - an incomplete
   * certification is already a hold, and calling it "expired" would be wrong.
   *
   * An EXPIRED certification is treated exactly like never-certified:
   * clearance is withdrawn and the work order locks again. That is the
   * behaviour Silfab described - lapsed installers cannot bill.
   */
  /**
   * Prefer Absorb's own certificate expiry over our computed window.
   * Only worth asking once the course is complete - no completion, no
   * certificate, nothing to expire. Any failure falls back silently and
   * is surfaced as expirySource/expiryNote rather than breaking the page.
   */
  let absorbExpiry: string | null = null;
  let expiryNote: string | undefined;
  if (completed) {
    if (title.name) {
      const look = await lookupCertificateExpiry(token, title.name);
      absorbExpiry = look.expiry;
      if (!look.expiry) expiryNote = look.reason;
    } else {
      // The certificates collection is matched on courseName, so with no
      // resolved title there is nothing to match against. Say that, rather
      // than reporting a lookup that never ran.
      expiryNote =
        "Certificate expiry not checked: the course title could not be read from Absorb, and the certificates collection is matched on course name.";
    }
  }

  const expiry = resolveExpiry(cert, completionDate, absorbExpiry);
  const expired = completed && expiry.status === "expired";
  const certified = completed && !expired;

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
                "Absorb did not return a title for this course or curriculum id. The portal shows this as unresolved rather than substituting one.",
            }),
      },
      certified,
      billingHold: !certified,
      status: !completed ? "incomplete" : expiry.status,
      expiresAt: expiry.expiresAt,
      daysRemaining: expiry.daysRemaining,
      expirySource: expiry.source,
      ...(expiryNote ? { expiryNote } : {}),
      recertifyUrl: expired ? "/api/silfab/recertify" : null,
      enrollmentStatus: enrolled ? enrollmentStatus : "NotEnrolled",
      progress,
      completionDate,
      checkedAt: new Date().toISOString(),
      ...(lookupNote ? { note: lookupNote } : {}),
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
};
