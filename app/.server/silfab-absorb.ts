import { InfuseBaseUrl } from "./infuse-api";

/**
 * Absorb certificate lookup for the Silfab Solar demo.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 * `my-course-enrollments/{id}` tells us whether a course is complete, but
 * carries no expiry. The Integration API's certificates collection does:
 *
 *   GET /users/{userId}/certificates
 *   { totalItems, returnedItems, limit, offset,
 *     certificates: [ { id, enrollmentId, fullName, courseName,
 *                       acquiredDate, expiryDate, notes, ... } ] }
 *
 * `expiryDate` is Absorb's own record, which beats computing one from
 * completionDate plus a guessed validity window.
 *
 * ── Deliberately defensive ──────────────────────────────────────────
 * The exact host and auth for this collection are not pinned down in this
 * codebase: the wrapper's existing calls use `X-Absorb-API-Key` + a learner
 * Bearer token against InfuseBaseUrl, while the published spec for this
 * endpoint shows `x-api-key` + `x-api-version: 2`. Rather than guess, every
 * function here fails soft and returns null. The caller then falls back to
 * the computed window and reports `expirySource`, so a wrong guess shows up
 * as "computed" in the API panel instead of a broken page.
 *
 * Set ABSORB_REST_URL if the certificates gateway differs from the tenant
 * Integration API host (e.g. a .ca portal uses rest.myabsorb.ca).
 */

const RestBaseUrl = process.env.ABSORB_REST_URL ?? InfuseBaseUrl;
const ApiKey = process.env.INFUSE_API_KEY ?? "";

export type AbsorbCertificate = {
  id?: string;
  enrollmentId?: string;
  fullName?: string;
  courseName?: string;
  acquiredDate?: string;
  expiryDate?: string | null;
  notes?: string;
};

function certUrl(userId: string): string {
  const base = RestBaseUrl.endsWith("/") ? RestBaseUrl : RestBaseUrl + "/";
  return new URL(`users/${encodeURIComponent(userId)}/certificates`, base).href;
}

/**
 * The learner's Absorb user ID. `getUserProfile` is typed as only
 * { firstName, lastName }, but the underlying my-profile response carries
 * more - so read it wide rather than re-typing someone else's endpoint.
 * Returns null when no id is present, which is a fallback, not an error.
 */
export async function getLearnerId(token: string): Promise<string | null> {
  try {
    const base = InfuseBaseUrl.endsWith("/") ? InfuseBaseUrl : InfuseBaseUrl + "/";
    const r = await fetch(new URL("my-profile", base).href, {
      headers: {
        "X-Absorb-API-Key": ApiKey,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
    });
    if (r.status !== 200) return null;
    const d = (await r.json()) as Record<string, unknown>;
    for (const k of ["id", "userId", "UserId", "Id"]) {
      const v = d[k];
      if (typeof v === "string" && v) return v;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The raw `my-course-enrollments/{id}` record, read wide.
 *
 * ── Why this exists ─────────────────────────────────────────
 * `getMyCourseEnrollment` in infuse-api.ts narrows the response to four
 * fields (progress, enrollmentStatus, enrollmentDate, completionDate), so
 * anything else Absorb sends is discarded before a caller can see it.
 *
 * This is the one call the cert-check already makes for exactly the course
 * whose title it needs, which makes it the best place to look for that
 * title - IF Absorb puts one there. Nothing in this codebase asserts that
 * it does, so this reads the object and checks rather than assuming a
 * field name. Finding no name is a normal outcome, not an error.
 */
export async function getEnrollmentRaw(
  token: string,
  courseId: string
): Promise<Record<string, unknown> | null> {
  try {
    const base = InfuseBaseUrl.endsWith("/") ? InfuseBaseUrl : InfuseBaseUrl + "/";
    const r = await fetch(
      new URL("my-course-enrollments/" + encodeURIComponent(courseId), base).href,
      {
        headers: {
          "X-Absorb-API-Key": ApiKey,
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
      }
    );
    if (r.status !== 200) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Pull a course title out of an enrollment record if one is present.
 * Checks the plausible spellings rather than betting on one, and returns
 * null when none of them carry a non-empty string.
 */
export function nameFromEnrollment(
  rec: Record<string, unknown> | null
): string | null {
  if (!rec) return null;
  const keys = ["courseName", "CourseName", "name", "Name", "title", "Title", "courseTitle"];
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // Some shapes nest the course: { course: { name: "..." } }
  const nested = rec.course ?? rec.Course;
  if (nested && typeof nested === "object") {
    const n = nested as Record<string, unknown>;
    for (const k of ["name", "Name", "title", "Title"]) {
      const v = n[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/**
 * Certificates held by a learner. Tries key-only auth first (as the published
 * spec shows), then retries with the learner Bearer token, because this
 * codebase's other calls need it. Returns null if neither shape works.
 */
export async function getCertificates(
  token: string,
  userId: string
): Promise<AbsorbCertificate[] | null> {
  const url = certUrl(userId);

  const attempts: HeadersInit[] = [
    { "x-api-key": ApiKey, "x-api-version": "2", "Content-Type": "application/json" },
    {
      "x-api-key": ApiKey,
      "X-Absorb-API-Key": ApiKey,
      "x-api-version": "2",
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  ];

  for (const headers of attempts) {
    try {
      const r = await fetch(url, { headers });
      if (r.status === 401 || r.status === 403) continue; // try the next auth shape
      if (r.status !== 200) return null;
      const d = (await r.json()) as { certificates?: AbsorbCertificate[] };
      return Array.isArray(d.certificates) ? d.certificates : [];
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Pick the certificate matching a course title and return its expiry.
 *
 * Matched on `courseName` because that is what the collection exposes and
 * what we already resolve live from the catalogue. When a learner holds
 * several certificates for the same course (a retake), the latest expiry
 * wins - that is the one that governs clearance.
 */
export function expiryForCourse(
  certs: AbsorbCertificate[],
  courseName: string
): string | null {
  const want = courseName.trim().toLowerCase();
  const matches = certs.filter(
    (c) => (c.courseName ?? "").trim().toLowerCase() === want
  );
  if (!matches.length) return null;

  let latest: number | null = null;
  for (const m of matches) {
    if (!m.expiryDate) continue;
    const ms = new Date(m.expiryDate).getTime();
    if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/** Convenience: resolve a course's certificate expiry, or null on any miss. */
export async function lookupCertificateExpiry(
  token: string,
  courseName: string
): Promise<{ expiry: string | null; reason?: string }> {
  const userId = await getLearnerId(token);
  if (!userId) return { expiry: null, reason: "learner id not exposed by my-profile" };

  const certs = await getCertificates(token, userId);
  if (certs === null) return { expiry: null, reason: "certificates endpoint unreachable" };
  if (!certs.length) return { expiry: null, reason: "learner holds no certificates" };

  const expiry = expiryForCourse(certs, courseName);
  return expiry
    ? { expiry }
    : { expiry: null, reason: "no certificate matched the course name" };
}
