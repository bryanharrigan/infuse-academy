import { json, LoaderFunctionArgs } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import {
  getMyCourseEnrollment,
  getUserProfile,
  getAllAvailableCatalog,
} from "~/.server/infuse-api";
import { lookupCertificateExpiry } from "~/.server/silfab-absorb";
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
 * course or curriculum in the LMS is reflected in the portal immediately
 * with no code change. Falls back to the configured name if the catalogue
 * cannot be read or the item is not in it.
 *
 * The catalogue is cached briefly in-process: a learner clicking between
 * work orders would otherwise re-fetch it on every check.
 */
type TitleCache = { at: number; byId: Map<string, string> };
let titleCache: TitleCache | null = null;
const TITLE_TTL_MS = 60_000;

async function resolveTitle(
  token: string,
  id: string,
  fallback: string
): Promise<{ name: string; source: "absorb" | "fallback" }> {
  try {
    if (!titleCache || Date.now() - titleCache.at > TITLE_TTL_MS) {
      const catalog = await getAllAvailableCatalog(token);
      const courses =
        ((catalog as unknown as { _embedded?: { courses?: unknown[] } })._embedded
          ?.courses as Array<Record<string, unknown>> | undefined) ?? [];
      const byId = new Map<string, string>();
      for (const c of courses) {
        const cid = typeof c.id === "string" ? c.id : undefined;
        const nm =
          (typeof c.name === "string" && c.name) ||
          (typeof c.title === "string" && c.title) ||
          undefined;
        if (cid && nm) byId.set(cid.toLowerCase(), nm);
      }
      titleCache = { at: Date.now(), byId };
    }
    const hit = titleCache.byId.get(id.toLowerCase());
    if (hit) return { name: hit, source: "absorb" };
  } catch {
    /* fall through to the configured name */
  }
  return { name: fallback, source: "fallback" };
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
  const title = await resolveTitle(token, cert.id, cert.fallbackName);

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
    const look = await lookupCertificateExpiry(token, title.name);
    absorbExpiry = look.expiry;
    if (!look.expiry) expiryNote = look.reason;
  }

  const expiry = resolveExpiry(cert, completionDate, absorbExpiry);
  const expired = completed && expiry.status === "expired";
  const certified = completed && !expired;

  return json(
    {
      learner,
      sku: sku ?? null,
      series: cert.series,
      certification: { id: cert.id, name: title.name, nameSource: title.source },
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
