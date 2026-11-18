/**
 * app/.server/lti/claims.ts
 *
 * LTI 1.3 claim URIs and the typed readers for the ones this tool uses.
 *
 * The claim names are long URNs and every one of them is easy to mistype into
 * an `undefined` that only shows up at runtime as a blank launch. They are
 * declared once here and nowhere else.
 */

export const CLAIM = {
  messageType: "https://purl.imsglobal.org/spec/lti/claim/message_type",
  version: "https://purl.imsglobal.org/spec/lti/claim/version",
  deploymentId: "https://purl.imsglobal.org/spec/lti/claim/deployment_id",
  targetLinkUri: "https://purl.imsglobal.org/spec/lti/claim/target_link_uri",
  resourceLink: "https://purl.imsglobal.org/spec/lti/claim/resource_link",
  context: "https://purl.imsglobal.org/spec/lti/claim/context",
  roles: "https://purl.imsglobal.org/spec/lti/claim/roles",
  custom: "https://purl.imsglobal.org/spec/lti/claim/custom",
  agsEndpoint: "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint",
  deepLinkingSettings:
    "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings",
  contentItems: "https://purl.imsglobal.org/spec/lti-dl/claim/content_items",
  deepLinkingData: "https://purl.imsglobal.org/spec/lti-dl/claim/data",
} as const;

export const MESSAGE_TYPE = {
  resourceLink: "LtiResourceLinkRequest",
  deepLinkingRequest: "LtiDeepLinkingRequest",
  deepLinkingResponse: "LtiDeepLinkingResponse",
} as const;

export const AGS_SCOPE = {
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score",
  lineItem: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
} as const;

export type AgsEndpoint = {
  scope?: string[];
  lineitems?: string;
  lineitem?: string;
};

export type DeepLinkingSettings = {
  deep_link_return_url?: string;
  accept_types?: string[];
  accept_presentation_document_targets?: string[];
  accept_multiple?: boolean;
  data?: string;
  title?: string;
};

export type LaunchIdentity = {
  /** The platform's stable user id. Unique within the issuer, not globally. */
  sub: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function readIdentity(claims: Record<string, unknown>): LaunchIdentity {
  const sub = str(claims.sub);
  if (!sub) {
    throw new Error("id_token has no `sub` — cannot identify the learner");
  }
  return {
    sub,
    email: str(claims.email),
    firstName: str(claims.given_name),
    lastName: str(claims.family_name),
    name: str(claims.name),
  };
}

/**
 * Split a display name into first/last when the platform sent `name` but not
 * `given_name` / `family_name`.
 *
 * Absorb requires both FirstName and LastName on user creation, so something
 * has to go in each field. "Last, First" is handled because several LMSs
 * render names that way; otherwise the last whitespace-separated token is
 * treated as the surname. This is a guess by construction — when the platform
 * sends the structured claims we use those and never come here.
 */
export function splitName(full: string | null): { first: string; last: string } {
  const value = (full ?? "").trim();
  if (!value) return { first: "LTI", last: "Learner" };

  if (value.includes(",")) {
    const [last, ...rest] = value.split(",");
    const first = rest.join(",").trim();
    if (last.trim() && first) return { first, last: last.trim() };
  }

  const parts = value.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

export function readCustom(claims: Record<string, unknown>): Record<string, string> {
  const raw = claims[CLAIM.custom];
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

export function readAgsEndpoint(claims: Record<string, unknown>): AgsEndpoint | null {
  const raw = claims[CLAIM.agsEndpoint];
  if (!raw || typeof raw !== "object") return null;
  return raw as AgsEndpoint;
}

export function readDeepLinkingSettings(
  claims: Record<string, unknown>
): DeepLinkingSettings | null {
  const raw = claims[CLAIM.deepLinkingSettings];
  if (!raw || typeof raw !== "object") return null;
  return raw as DeepLinkingSettings;
}

export function readResourceLinkTitle(claims: Record<string, unknown>): string | null {
  const raw = claims[CLAIM.resourceLink];
  if (!raw || typeof raw !== "object") return null;
  return str((raw as Record<string, unknown>).title);
}

export function isInstructor(claims: Record<string, unknown>): boolean {
  const roles = claims[CLAIM.roles];
  if (!Array.isArray(roles)) return false;
  return roles.some(
    (r) =>
      typeof r === "string" &&
      /#(Instructor|Administrator|ContentDeveloper|TeachingAssistant)$/.test(r)
  );
}
