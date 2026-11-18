/**
 * app/.server/lti/platforms.ts
 *
 * The LTI platforms (host Absorb portals) allowed to launch this tool.
 *
 * In this architecture the HOST portal is the LTI Consumer/Platform and this
 * app is the Tool. The course content itself lives in a DIFFERENT Absorb
 * portal — the source portal, configured in portal.ts. Nothing here knows
 * about the source portal, and that separation is deliberate: one host portal
 * could be pointed at different source content, and vice versa.
 *
 * CONFIGURATION
 * -------------
 * `LTI_PLATFORMS` is a JSON array. One entry per host portal registration:
 *
 * [
 *   {
 *     "id": "host-portal",
 *     "issuer": "https://hostportal.myabsorb.com",
 *     "clientId": "<client id Absorb shows after registering the tool>",
 *     "deploymentIds": ["<deployment id>"],
 *     "authUrl": "https://hostportal.myabsorb.com/lti/authorize",
 *     "tokenUrl": "https://hostportal.myabsorb.com/lti/token",
 *     "jwksUrl": "https://hostportal.myabsorb.com/lti/jwks"
 *   }
 * ]
 *
 * The four URLs come from the host portal's LTI Registration tile — do not
 * guess them. Absorb's Consumer Mode article documents the exchange of
 * configuration values as a manual copy between the two systems, so expect to
 * paste these by hand rather than discover them.
 *
 * `deploymentIds` may be left empty during first setup: the launch handler
 * then accepts any deployment and logs the one it saw, which is the quickest
 * way to learn the value. Fill it in afterwards — an empty list means any
 * deployment of that client can launch you.
 */

export type LtiPlatform = {
  /** Our own short name for this registration, used in logs and launch keys. */
  id: string;
  issuer: string;
  clientId: string;
  deploymentIds: string[];
  /** OIDC authorization endpoint we redirect to at login initiation. */
  authUrl: string;
  /** OAuth2 token endpoint, for AGS client_credentials. */
  tokenUrl: string;
  /** Platform's public keys, for verifying id_tokens. */
  jwksUrl: string;
};

let cached: LtiPlatform[] | null = null;

function parsePlatforms(): LtiPlatform[] {
  const raw = process.env.LTI_PLATFORMS ?? "";
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Thrown rather than swallowed: a typo here disables every launch, and a
    // silent empty list presents as "the platform is not registered", which
    // sends you looking in the wrong system entirely.
    throw new Error(
      "LTI_PLATFORMS is not valid JSON: " +
        (err instanceof Error ? err.message : String(err))
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("LTI_PLATFORMS must be a JSON array of platform objects");
  }

  return parsed.map((entry, i) => {
    const p = entry as Partial<LtiPlatform>;
    for (const field of ["issuer", "clientId", "authUrl", "tokenUrl", "jwksUrl"] as const) {
      if (!p[field]) {
        throw new Error(`LTI_PLATFORMS[${i}] is missing required field "${field}"`);
      }
    }
    return {
      id: p.id || `platform-${i}`,
      issuer: p.issuer!,
      clientId: p.clientId!,
      deploymentIds: Array.isArray(p.deploymentIds) ? p.deploymentIds : [],
      authUrl: p.authUrl!,
      tokenUrl: p.tokenUrl!,
      jwksUrl: p.jwksUrl!,
    };
  });
}

export function allPlatforms(): LtiPlatform[] {
  if (!cached) cached = parsePlatforms();
  return cached;
}

/**
 * Find the registration for an incoming launch.
 *
 * `clientId` is optional because the login-initiation request only carries it
 * when the platform supports multiple registrations per issuer. When it is
 * absent and one issuer has several registrations we cannot guess, so we fail
 * loudly rather than picking the first.
 */
export function findPlatform(
  issuer: string | null,
  clientId?: string | null
): LtiPlatform {
  if (!issuer) throw new Error("Launch is missing the `iss` parameter");

  const matches = allPlatforms().filter((p) => p.issuer === issuer);
  if (matches.length === 0) {
    throw new Error(
      `No LTI platform registered for issuer "${issuer}". ` +
        `Registered issuers: ${allPlatforms().map((p) => p.issuer).join(", ") || "none"}`
    );
  }
  if (clientId) {
    const exact = matches.find((p) => p.clientId === clientId);
    if (!exact) {
      throw new Error(
        `Issuer "${issuer}" is registered but not with client_id "${clientId}"`
      );
    }
    return exact;
  }
  if (matches.length > 1) {
    throw new Error(
      `Issuer "${issuer}" has ${matches.length} registrations and the launch ` +
        `did not specify client_id — cannot determine which to use`
    );
  }
  return matches[0];
}

/** An empty deploymentIds list means "not yet pinned" — see the header. */
export function deploymentAllowed(
  platform: LtiPlatform,
  deploymentId: string | undefined
): boolean {
  if (platform.deploymentIds.length === 0) return true;
  return Boolean(deploymentId && platform.deploymentIds.includes(deploymentId));
}
