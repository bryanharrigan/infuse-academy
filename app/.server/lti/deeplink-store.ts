/**
 * app/.server/lti/deeplink-store.ts
 *
 * Short-lived record of a deep-linking request, held between the admin
 * arriving at the picker and submitting their choice.
 *
 * `returnUrl` and `data` come from the platform's `deep_linking_settings` and
 * must be echoed back exactly. Keeping them server-side rather than in a
 * hidden form field means the browser cannot be used to redirect our signed
 * response somewhere else — a signed JWT posted to an attacker-chosen URL is
 * a credential leak, not just a failed configuration.
 */

const TTL_MS = 60 * 60 * 1000;

export type DeepLinkRequest = {
  dlId: string;
  platformId: string;
  deploymentId: string | null;
  /** Where the signed LtiDeepLinkingResponse must be POSTed. */
  returnUrl: string;
  /** Opaque platform value to echo back untouched, if it sent one. */
  data: string | null;
  createdAt: number;
};

const requests = new Map<string, DeepLinkRequest>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of requests) {
    if (now - v.createdAt > TTL_MS) requests.delete(k);
  }
}

export function rememberDeepLink(entry: DeepLinkRequest): void {
  sweep();
  requests.set(entry.dlId, entry);
}

export function getDeepLink(dlId: string | null): DeepLinkRequest | null {
  if (!dlId) return null;
  const entry = requests.get(dlId) ?? null;
  if (entry && Date.now() - entry.createdAt > TTL_MS) {
    requests.delete(dlId);
    return null;
  }
  return entry;
}
