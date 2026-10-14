import { json, LoaderFunctionArgs } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { getMyCourseEnrollment, getUserProfile } from "~/.server/infuse-api";

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

type Certification = {
  series: string;
  /** Course or curriculum ID with Certificate enabled. */
  id: string;
  name: string;
  /** Panel SKUs in this series, as shown on the portal. */
  skus: string[];
};

/**
 * NOTE: `name` here must match the course/curriculum title in Absorb. The
 * portal displays this value, and nothing re-reads the title from the LMS,
 * so renaming in Absorb without updating here would make the screen lie.
 */
const CERTIFICATIONS: Certification[] = [
  {
    series: "Silfab Commercial",
    id: "b6e3d500-ae22-47e9-bae5-9a8933dfe042",
    name: "High-Wattage Bifacial Safety (XM+)",
    skus: ["SIL-590-XM-NTC", "SIL-580-XM-NTC", "SIL-570-XM-NTC", "SIL-520-QM-NTC", "SIL-500-HM"],
  },
  {
    series: "Silfab Prime",
    id: "6dcd9527-3d0f-469c-8753-2f28bdbc8de4",
    name: "Prime Series QD Installation",
    skus: ["SIL-440-QD-NTC", "SIL-430-QD-NTC", "SIL-420-QD-NTC", "SIL-410-HC", "SIL-370-HC"],
  },
  {
    series: "Silfab Utility",
    id: "8ba748f0-cbd4-40a9-9196-5331b204832f",
    name: "Utility Series XL Certification",
    skus: ["SIL-620-XL-NTC", "SIL-630-XL-NTC", "SIL-640-XL-NTC"],
  },
];

function findCertification(sku: string | null, series: string | null) {
  if (sku) {
    const bySku = CERTIFICATIONS.find((c) =>
      c.skus.some((s) => s.toLowerCase() === sku.toLowerCase())
    );
    if (bySku) return bySku;
  }
  if (series) {
    const bySeries = CERTIFICATIONS.find(
      (c) => c.series.toLowerCase() === series.toLowerCase()
    );
    if (bySeries) return bySeries;
  }
  return null;
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
        knownSeries: CERTIFICATIONS.map((c) => c.series),
      },
      { status: 404 }
    );
  }

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

  const certified =
    enrolled &&
    (String(enrollmentStatus).toLowerCase() === "complete" || !!completionDate);

  return json(
    {
      learner,
      sku: sku ?? null,
      series: cert.series,
      certification: { id: cert.id, name: cert.name },
      certified,
      billingHold: !certified,
      enrollmentStatus: enrolled ? enrollmentStatus : "NotEnrolled",
      progress,
      completionDate,
      checkedAt: new Date().toISOString(),
      ...(lookupNote ? { note: lookupNote } : {}),
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
};
