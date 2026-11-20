/**
 * app/routes/lti.smowl-probe.ts  ->  GET /lti/smowl-probe
 *
 * Works out what the SMOWL `aud` claim should be, without a deploy cycle per
 * guess.
 *
 * WHY THIS EXISTS
 * ---------------
 * Smowltech's three official code samples all leave the audience as the
 * literal placeholder `smowl_platform_domain`. It is the one field in the
 * integration that cannot be inferred, and getting it wrong surfaces as an
 * opaque token error rather than anything readable.
 *
 * Asking support is the correct fix, but it is a human round-trip measured in
 * hours. This endpoint signs a token with whatever audience you name in the
 * query string and hands back the finished SMOWL URL, so every candidate can
 * be tried in one browser session. Set the winner as SMOWL_AUDIENCE.
 *
 * SAFETY
 * ------
 * This emits SIGNED TOKENS, so unlike /lti/diag it is useless without
 * LTI_DIAG_KEY: no key set, or a wrong key, and it refuses outright rather
 * than degrading to a partial view. The secret itself is never returned, and
 * the learner is a fixed dummy so no real person's details leave the server.
 *
 * DELETE THIS once SMOWL_AUDIENCE is confirmed. It earns its keep for an
 * afternoon, not forever.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";

import {
  enabled as smowlEnabled,
  monitoringUrl,
  registrationUrl,
  smowlConfig,
} from "~/.server/lti/smowl";

/**
 * Ordered by how likely each is to be right, most likely first.
 *
 * `smowl_platform_domain` leads because integrations do ship with a sample's
 * placeholder left in place more often than anyone admits, and because the
 * name reads like a constant rather than a thing to substitute.
 */
const CANDIDATES = (toolHost: string) => [
  "smowl_platform_domain",
  toolHost,
  "https://swl.smowltech.net",
  "https://app.smowltech.net",
  process.env.SMOWL_ENTITY_NAME ?? "",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const diagKey = process.env.LTI_DIAG_KEY ?? "";

  if (!diagKey || url.searchParams.get("key") !== diagKey) {
    return json(
      { error: "Set LTI_DIAG_KEY and pass ?key=<it>. This endpoint signs tokens." },
      { status: 403 }
    );
  }

  const cfg = smowlConfig();
  if (!smowlEnabled(cfg)) {
    return json({
      error:
        "SMOWL is not configured. SMOWL_ENTITY_NAME, SMOWL_ENTITY_KEY and " +
        "SMOWL_JWT_SECRET must all be set before a token can be signed.",
      entityNameSet: Boolean(cfg.entityName),
      entityKeySet: Boolean(cfg.entityKey),
      jwtSecretSet: Boolean(cfg.jwtSecret),
    });
  }

  const toolHost = new URL(request.url).host;
  const audience = url.searchParams.get("aud") ?? cfg.audience;
  const probeCfg = { ...cfg, audience };

  // Fixed dummy. Real learner details should never be needed to answer the
  // only question this endpoint exists to answer.
  const learner = {
    userId: "probe0000000000000000000000000001",
    name: "Probe Learner",
    email: "probe@example.com",
  };
  const activity = {
    activityId: "probe0000000000000000000000000002",
    containerId: "probe0000000000000000000000000003",
    activityUrl: `${url.origin}/lti/smowl-probe?key=${encodeURIComponent(diagKey)}`,
  };

  return json({
    audienceUsed: audience,
    audienceSource: url.searchParams.get("aud") ? "?aud= override" : "SMOWL_AUDIENCE / fallback",
    entityName: cfg.entityName,
    activityType: cfg.activityType,
    candidatesToTry: CANDIDATES(toolHost).filter(Boolean),
    howToUse:
      "Open monitoringUrl in a new tab. A SMOWL camera-check page means the " +
      "audience was accepted; a token error means try the next candidate. " +
      "Then set SMOWL_AUDIENCE to the one that worked.",
    monitoringUrl: monitoringUrl(probeCfg, learner, activity, 1),
    registrationUrl: registrationUrl(probeCfg, learner, activity),
  });
};
