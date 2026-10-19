/**
 * SKU -> certification mapping for the Silfab Solar demo.
 *
 * ── How a certification is modelled ─────────────────────────────────
 * In Absorb a certification is any course OR curriculum with "Certificate"
 * enabled. Completing it AWARDS a certificate, and the certificate - not the
 * completion - is the credential that clears a work order.
 *
 * This file therefore maps a panel SKU to the course that mints the
 * certificate. Deciding whether the learner currently holds a valid one is
 * `silfab-absorb.ts`'s job, against Absorb's certificates collection.
 *
 * ── What is deliberately NOT here ───────────────────────────────────
 * There used to be a `validMonths` window and a `resolveExpiry()` that
 * computed an expiry from the completion date whenever Absorb supplied
 * none. Both are gone. Absorb owns certificate expiry, including an admin
 * expiring one by hand, and a locally computed window would mask exactly
 * that: the certificate would keep reading as valid for however many months
 * the config claimed. If Absorb gives no expiry date, the certificate does
 * not expire, and the portal says so rather than inventing a deadline.
 *
 * There is also no `fallbackName`. Titles are resolved live from Absorb; an
 * unresolved one is reported as unresolved, never substituted.
 */

export type Certification = {
  series: string;
  /** Course or curriculum ID with Certificate enabled. */
  id: string;
  /** Panel SKUs in this series, as shown on the portal. */
  skus: string[];
};

export const CERTIFICATIONS: Certification[] = [
  {
    series: "Silfab Commercial",
    id: "b6e3d500-ae22-47e9-bae5-9a8933dfe042",
    skus: ["SIL-590-XM-NTC", "SIL-580-XM-NTC", "SIL-570-XM-NTC", "SIL-520-QM-NTC", "SIL-500-HM"],
  },
  {
    series: "Silfab Prime",
    id: "6dcd9527-3d0f-469c-8753-2f28bdbc8de4",
    skus: ["SIL-440-QD-NTC", "SIL-430-QD-NTC", "SIL-420-QD-NTC", "SIL-410-HC", "SIL-370-HC"],
  },
  {
    series: "Silfab Utility",
    id: "8ba748f0-cbd4-40a9-9196-5331b204832f",
    skus: ["SIL-620-XL-NTC", "SIL-630-XL-NTC", "SIL-640-XL-NTC"],
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
