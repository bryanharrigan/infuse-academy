import { InfuseBaseUrl } from "./infuse-api";

/**
 * Absorb CERTIFICATE lookup for the Silfab Solar demo.
 *
 * ┌─ What changed, and why it matters ──────────────────────────────────┐
 * │ The first version gated billing on whether the COURSE was complete, │
 * │ and treated certificates only as an expiry hint. That is wrong:     │
 * │                                                                     │
 * │   - Completing a course MINTS a certificate. The certificate, not   │
 * │     the completion, is the credential.                              │
 * │   - One course yields MANY certificates over time - a learner who   │
 * │     retakes it holds several, each with its own id and expiry.      │
 * │   - An admin can expire a certificate by hand. NOTHING about the    │
 * │     course enrollment changes when they do.                         │
 * │                                                                     │
 * │ So "is this installer cleared?" is: do they hold at least one       │
 * │ certificate for that course which has not expired? Completion       │
 * │ cannot answer it, and a validity window computed from a completion  │
 * │ date actively HIDES a manual expiration.                            │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   GET /users/{userId}/certificates
 *   { totalItems, returnedItems, limit, offset,
 *     certificates: [ { id, enrollmentId, fullName, courseName,
 *                       acquiredDate, expiryDate, notes, ... } ] }
 *
 * ── Fail closed, and say which ──────────────────────────────────────
 * This gates billing, so "the certificate list could not be read" must
 * never render as "cleared". Every function reports WHY it could not
 * answer rather than returning something that reads like a negative, and
 * the route surfaces a distinct "unknown" state rather than a false hold.
 *
 * ── Read wide, assume nothing ───────────────────────────────────────
 * The exact field spellings on a certificate are not pinned down in this
 * codebase. Rather than bet on one, these helpers check the plausible
 * spellings and REPORT which one answered, so the portal shows how the
 * match was made instead of implying more certainty than we have.
 *
 * Set ABSORB_REST_URL if the certificates gateway differs from the tenant
 * Integration API host (e.g. a .ca portal uses rest.myabsorb.ca).
 */

const RestBaseUrl = process.env.ABSORB_REST_URL ?? InfuseBaseUrl;
const ApiKey = process.env.INFUSE_API_KEY ?? "";

/** Loose shape: unknown fields are kept so matching can read them. */
export type AbsorbCertificate = Record<string, unknown> & {
  id?: string;
  enrollmentId?: string;
  fullName?: string;
  courseName?: string;
  acquiredDate?: string;
  expiryDate?: string | null;
  notes?: string;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function certUrl(userId: string, limit: number, offset: number): string {
  const base = RestBaseUrl.endsWith("/") ? RestBaseUrl : RestBaseUrl + "/";
  const u = new URL("users/" + encodeURIComponent(userId) + "/certificates", base);
  u.searchParams.set("_limit", String(limit));
  u.searchParams.set("_offset", String(offset));
  return u.href;
}

/**
 * The learner's Absorb user ID. `getUserProfile` is typed as only
 * { firstName, lastName }, but my-profile carries more - so read it wide
 * rather than re-typing someone else's endpoint.
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
      const v = str(d[k]);
      if (v) return v;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The raw `my-course-enrollments/{id}` record.
 *
 * No longer the gate. It supplies the enrollment id - one of the keys a
 * certificate can be matched on - and the progress figure shown while
 * training is still underway.
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

/** A course title from an enrollment record, if one is present. */
export function nameFromEnrollment(rec: Record<string, unknown> | null): string | null {
  if (!rec) return null;
  for (const k of ["courseName", "CourseName", "name", "Name", "title", "Title", "courseTitle"]) {
    const v = str(rec[k]);
    if (v) return v;
  }
  const nested = rec.course ?? rec.Course;
  if (nested && typeof nested === "object") {
    const n = nested as Record<string, unknown>;
    for (const k of ["name", "Name", "title", "Title"]) {
      const v = str(n[k]);
      if (v) return v;
    }
  }
  return null;
}

/** The enrollment's own id, used to match certificates back to it. */
export function idFromEnrollment(rec: Record<string, unknown> | null): string | null {
  if (!rec) return null;
  for (const k of ["id", "Id", "enrollmentId", "EnrollmentId"]) {
    const v = str(rec[k]);
    if (v) return v;
  }
  return null;
}

export type CertificateFetch = {
  /** null means UNKNOWN, never "holds none". */
  certificates: AbsorbCertificate[] | null;
  reason?: string;
  /** True when more certificates exist than were returned. */
  partial?: boolean;
};

/**
 * Every certificate the learner holds.
 *
 * Tries key-only auth first (as the published spec shows), then retries with
 * the learner Bearer token, because this codebase's other calls need it.
 * Pages while the response says there are more; if the paging params are
 * ignored, `partial` says the answer may be short rather than pretending it
 * is complete.
 */
export async function getCertificates(
  token: string,
  userId: string
): Promise<CertificateFetch> {
  const PAGE = 100;
  const MAX_PAGES = 20;

  const authShapes: HeadersInit[] = [
    { "x-api-key": ApiKey, "x-api-version": "2", "Content-Type": "application/json" },
    {
      "x-api-key": ApiKey,
      "X-Absorb-API-Key": ApiKey,
      "x-api-version": "2",
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  ];

  for (const headers of authShapes) {
    const all: AbsorbCertificate[] = [];
    let offset = 0;
    let total: number | null = null;
    let rejected = false;

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await fetch(certUrl(userId, PAGE, offset), { headers });
        if (r.status === 401 || r.status === 403) { rejected = true; break; }
        if (r.status !== 200) {
          return { certificates: null, reason: "certificates endpoint returned " + r.status };
        }

        const d = (await r.json()) as {
          certificates?: AbsorbCertificate[];
          totalItems?: number;
        };
        const batch = Array.isArray(d.certificates) ? d.certificates : [];
        all.push(...batch);
        if (typeof d.totalItems === "number") total = d.totalItems;

        if (batch.length < PAGE) break;
        offset += batch.length;
        if (total !== null && all.length >= total) break;
      }
    } catch (err) {
      return {
        certificates: null,
        reason: "certificates request failed: " + (err instanceof Error ? err.message : String(err)),
      };
    }

    if (rejected) continue; // try the next auth shape
    return {
      certificates: all,
      ...(total !== null && all.length < total
        ? { partial: true, reason: "read " + all.length + " of " + total + " certificates" }
        : {}),
    };
  }

  return { certificates: null, reason: "certificates endpoint rejected both auth shapes" };
}

// ------------------------------------------------------------- matching --

/** A certificate's course id, under whichever spelling it uses. */
function certCourseId(c: AbsorbCertificate): string | null {
  for (const k of ["courseId", "CourseId", "course_id"]) {
    const v = str(c[k]);
    if (v) return v;
  }
  const nested = c.course ?? c.Course;
  if (nested && typeof nested === "object") {
    const v = str((nested as Record<string, unknown>).id);
    if (v) return v;
  }
  return null;
}

export type MatchKey = "courseId" | "enrollmentId" | "courseName" | "none";

export type CertificateMatch = {
  matches: AbsorbCertificate[];
  /** Which field identified them. Reported, because it is not all the same. */
  matchedOn: MatchKey;
};

/**
 * The certificates belonging to one course, tried most-reliable first.
 *
 * An id match is exact. A NAME match is not, and breaks the moment the course
 * is renamed in Absorb - which this demo actively encourages. So the key that
 * answered is returned with the matches and shown in the portal, rather than
 * quietly presenting a fuzzy match as a firm one.
 */
export function certificatesForCourse(
  certs: AbsorbCertificate[],
  opts: { courseId?: string | null; courseName?: string | null; enrollmentId?: string | null }
): CertificateMatch {
  if (opts.courseId) {
    const want = opts.courseId.toLowerCase();
    const hit = certs.filter((c) => {
      const cid = certCourseId(c);
      return cid !== null && cid.toLowerCase() === want;
    });
    if (hit.length) return { matches: hit, matchedOn: "courseId" };
  }

  if (opts.enrollmentId) {
    const want = opts.enrollmentId.toLowerCase();
    const hit = certs.filter((c) => {
      const eid = str(c.enrollmentId) ?? str(c.EnrollmentId);
      return eid !== null && eid.toLowerCase() === want;
    });
    if (hit.length) return { matches: hit, matchedOn: "enrollmentId" };
  }

  if (opts.courseName) {
    const want = opts.courseName.trim().toLowerCase();
    const hit = certs.filter((c) => {
      const nm = str(c.courseName) ?? str(c.CourseName);
      return nm !== null && nm.toLowerCase() === want;
    });
    if (hit.length) return { matches: hit, matchedOn: "courseName" };
  }

  return { matches: [], matchedOn: "none" };
}

// ------------------------------------------------------------- validity --

/** Days before expiry at which the portal starts warning. */
export const EXPIRING_SOON_DAYS = 30;

export type CertVerdict = {
  /** Holds at least one unexpired certificate for this course. */
  valid: boolean;
  status: "valid" | "expiring" | "expired" | "none";
  /** The certificate granting clearance, or the latest lapsed one. */
  certificateId: string | null;
  acquiredAt: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  /** The governing certificate carries no expiry at all. */
  neverExpires: boolean;
  /** How many certificates this learner holds for the course. */
  held: number;
  /** A certificate was explicitly marked revoked/inactive, not merely dated. */
  revoked?: boolean;
};

/**
 * Has an admin explicitly killed this certificate, independently of its date?
 * Checked rather than assumed: only an unambiguous boolean or a past dated
 * field counts, and anything unrecognised is ignored rather than guessed at.
 */
function explicitlyRevoked(c: AbsorbCertificate): boolean {
  for (const k of ["isRevoked", "revoked", "isExpired", "expired"]) {
    if (c[k] === true) return true;
  }
  for (const k of ["isActive", "active"]) {
    if (c[k] === false) return true;
  }
  for (const k of ["revokedDate", "revokedAt"]) {
    const v = str(c[k]);
    if (v) {
      const ms = new Date(v).getTime();
      if (Number.isFinite(ms) && ms <= Date.now()) return true;
    }
  }
  return false;
}

/**
 * Decide clearance from the certificates held for one course.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ A learner keeps every certificate they have ever earned for a   │
 * │ course, lapsed ones included. Clearance therefore asks whether  │
 * │ ANY of them is still live - not whether the newest is, and not  │
 * │ whether the course was completed.                               │
 * │                                                                 │
 * │ There is NO computed fallback. If Absorb supplies no expiry the │
 * │ certificate does not expire, and the portal says exactly that.  │
 * │ A window invented from a completion date is how a manually      │
 * │ expired certificate would keep reading as valid.                │
 * └─────────────────────────────────────────────────────────────────┘
 */
export function assessCertificates(certs: AbsorbCertificate[]): CertVerdict {
  const base: CertVerdict = {
    valid: false,
    status: "none",
    certificateId: null,
    acquiredAt: null,
    expiresAt: null,
    daysRemaining: null,
    neverExpires: false,
    held: certs.length,
  };
  if (!certs.length) return base;

  const live = certs.filter((c) => !explicitlyRevoked(c));

  // No expiry date means it never lapses, so it clears outright.
  const evergreen = live.find((c) => !str(c.expiryDate));
  if (evergreen) {
    return {
      ...base,
      valid: true,
      status: "valid",
      certificateId: str(evergreen.id),
      acquiredAt: str(evergreen.acquiredDate),
      neverExpires: true,
    };
  }

  // Otherwise the one expiring furthest out governs.
  let best: { cert: AbsorbCertificate; ms: number } | null = null;
  for (const c of live) {
    const iso = str(c.expiryDate);
    if (!iso) continue;
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms > best.ms) best = { cert: c, ms };
  }

  if (best === null) {
    // Every certificate revoked, or none carried a readable date.
    const anyRevoked = certs.some(explicitlyRevoked);
    return {
      ...base,
      status: anyRevoked ? "expired" : "none",
      ...(anyRevoked ? { revoked: true } : {}),
    };
  }

  const daysRemaining = Math.floor((best.ms - Date.now()) / 86_400_000);
  const status: CertVerdict["status"] =
    daysRemaining < 0 ? "expired" : daysRemaining <= EXPIRING_SOON_DAYS ? "expiring" : "valid";

  return {
    ...base,
    valid: status !== "expired",
    status,
    certificateId: str(best.cert.id),
    acquiredAt: str(best.cert.acquiredDate),
    expiresAt: new Date(best.ms).toISOString(),
    daysRemaining,
  };
}
