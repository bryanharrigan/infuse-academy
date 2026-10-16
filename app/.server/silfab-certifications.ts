/**
 * Certification catalogue + expiry rules for the Silfab Solar demo.
 *
 * Shared by the cert-check and recertify routes so the SKU -> certification
 * mapping exists in exactly one place.
 *
 * ── How a certification is modelled ─────────────────────────────────
 * In Absorb, a certification is any course OR curriculum with "Certificate"
 * enabled; the certificate is awarded on completion. So "is this installer
 * certified?" reduces to "is that item complete - and still in date?".
 */

export type Certification = {
  series: string;
  /** Course or curriculum ID with Certificate enabled. */
  id: string;
  /**
   * There is deliberately NO fallback title here.
   *
   * The display name is resolved from Absorb at request time and from
   * nowhere else. If it cannot be resolved, the API returns `name: null`
   * with `nameSource: "unresolved"` and the portal says so on screen.
   *
   * This field used to be `fallbackName`, holding plausible-sounding
   * titles ("High-Wattage Bifacial Safety (XM+)"). They were invented, and
   * because they read like real Silfab courses a failed lookup showed a
   * convincing fiction nobody would catch mid-demo. A visible failure
   * beats a silent fabrication - the same rule as rendering no button
   * where there is no real course behind it.
   */
  /** Panel SKUs in this series, as shown on the portal. */
  skus: string[];
  /**
   * FALLBACK validity window in months, used only when Absorb does not
   * supply a real expiry date (see resolveExpiry). Leave undefined to treat
   * the certification as non-expiring.
   */
  validMonths?: number;
};

export const CERTIFICATIONS: Certification[] = [
  {
    series: "Silfab Commercial",
    id: "b6e3d500-ae22-47e9-bae5-9a8933dfe042",
    skus: ["SIL-590-XM-NTC", "SIL-580-XM-NTC", "SIL-570-XM-NTC", "SIL-520-QM-NTC", "SIL-500-HM"],
    validMonths: 12,
  },
  {
    series: "Silfab Prime",
    id: "6dcd9527-3d0f-469c-8753-2f28bdbc8de4",
    skus: ["SIL-440-QD-NTC", "SIL-430-QD-NTC", "SIL-420-QD-NTC", "SIL-410-HC", "SIL-370-HC"],
    validMonths: 24,
  },
  {
    series: "Silfab Utility",
    id: "8ba748f0-cbd4-40a9-9196-5331b204832f",
    skus: ["SIL-620-XL-NTC", "SIL-630-XL-NTC", "SIL-640-XL-NTC"],
    validMonths: 12,
  },
];

export function findCertification(
  sku: string | null,
  series: string | null
): Certification | null {
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

export type CertStatus = "valid" | "expiring" | "expired" | "none";

export type ExpiryResult = {
  /** ISO date the certification lapses, or null when nothing provides one. */
  expiresAt: string | null;
  /** Whole days until expiry; negative once lapsed. Null when no expiry. */
  daysRemaining: number | null;
  status: CertStatus;
  /** Where the date came from, so the portal never implies more than it knows. */
  source: "absorb" | "computed" | "none";
};

/** Days before expiry at which the portal starts warning. */
export const EXPIRING_SOON_DAYS = 30;

/**
 * Work out whether a completed certification is still in date.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ SEAM: Absorb's own certificate expiry date goes here.           │
 * │                                                                 │
 * │ `getMyCourseEnrollment` currently returns only progress,        │
 * │ enrollmentStatus, enrollmentDate and completionDate - there is  │
 * │ no expiry field in the wrapper. When the real field or endpoint │
 * │ is known, pass it in as `absorbExpiry` and it wins outright;    │
 * │ the computed path below becomes dead weight and can go.         │
 * │                                                                 │
 * │ Until then `validMonths` is OUR arithmetic over completionDate, │
 * │ not Absorb's record, and `source: "computed"` says so in the    │
 * │ API response rather than quietly implying otherwise.            │
 * └─────────────────────────────────────────────────────────────────┘
 */
export function resolveExpiry(
  cert: Certification,
  completionDate: string | null,
  absorbExpiry?: string | null
): ExpiryResult {
  const now = Date.now();

  const toResult = (iso: string, source: "absorb" | "computed"): ExpiryResult => {
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) {
      return { expiresAt: null, daysRemaining: null, status: "valid", source: "none" };
    }
    const daysRemaining = Math.floor((ms - now) / 86_400_000);
    const status: CertStatus =
      daysRemaining < 0 ? "expired" : daysRemaining <= EXPIRING_SOON_DAYS ? "expiring" : "valid";
    return { expiresAt: new Date(ms).toISOString(), daysRemaining, status, source };
  };

  // 1. Absorb's own date, once we have it, is authoritative.
  if (absorbExpiry) return toResult(absorbExpiry, "absorb");

  // 2. Otherwise derive it, but only if we know both the completion and a window.
  if (completionDate && cert.validMonths) {
    const d = new Date(completionDate);
    if (Number.isFinite(d.getTime())) {
      d.setMonth(d.getMonth() + cert.validMonths);
      return toResult(d.toISOString(), "computed");
    }
  }

  // 3. Nothing to go on - treat as non-expiring rather than guessing.
  return { expiresAt: null, daysRemaining: null, status: "valid", source: "none" };
}
