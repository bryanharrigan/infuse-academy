/**
 * app/routes/lti.diag.ts  ->  GET /lti/diag
 *
 * Read-only diagnostics for the LTI flow. Changes nothing, starts nothing.
 *
 * WHY THIS EXISTS
 * ---------------
 * The service log lives on a machine that is not reachable from where this
 * gets debugged, which turned several failures into guesswork: a blank picker,
 * a silent button, a completion that went nowhere. Each cost a deploy cycle to
 * narrow down. This answers "what actually happened" from a browser.
 *
 * WHAT IT WILL NOT TELL YOU
 * -------------------------
 * No secrets, no tokens, no signed JWTs, no passwords. Configuration is
 * reported as present/absent booleans only. Learner subjects are truncated.
 *
 * ACCESS
 * ------
 * With LTI_DIAG_KEY set, `?key=` must match and you get the full view.
 * Without it, the endpoint still answers but only with counts and
 * configuration booleans -- enough to tell whether the webhook secret is set
 * and whether any launch has been recorded, which is usually the question,
 * without putting course ids on a public URL.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";

import { ltiConfigured, ToolBaseUrl, ToolKeyId } from "~/.server/lti/keys";
import { allPlatforms } from "~/.server/lti/platforms";
import {
  adminProvisioningConfigured,
  sharedLearnerConfigured,
  sourcePortal,
} from "~/.server/lti/portal";
import {
  launchSummaries,
  recentLtiEvents,
  storeStats,
} from "~/.server/lti/store";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const diagKey = process.env.LTI_DIAG_KEY ?? "";
  const authorised = Boolean(diagKey) && url.searchParams.get("key") === diagKey;

  const cfg = sourcePortal();
  const stats = storeStats();

  // Safe at any access level: booleans and counts, no identifiers.
  const summary = {
    tool: {
      configured: ltiConfigured(),
      baseUrl: ToolBaseUrl || "(PUBLIC_URL not set)",
      keyId: ToolKeyId,
    },
    platforms: allPlatforms().map((p) => ({
      id: p.id,
      issuer: p.issuer,
      deploymentsPinned: p.deploymentIds.length > 0,
    })),
    sourcePortal: {
      baseUrl: cfg.baseUrl || "(not set)",
      portalUrl: cfg.portalUrl || "(not set)",
      restUrl: cfg.restUrl || "(not set)",
      infuseApiKeySet: Boolean(cfg.apiKey),
      restApiKeySet: Boolean(cfg.restApiKey),
      adminCredentialsSet: Boolean(cfg.adminUsername && cfg.adminPassword),
      sharedLearnerSet: sharedLearnerConfigured(cfg),
      /** False here means every launch uses the shared learner. */
      perLearnerProvisioning: adminProvisioningConfigured(cfg),
    },
    webhook: {
      secretSet: Boolean(process.env.LTI_WEBHOOK_SECRET),
      url: ToolBaseUrl ? `${ToolBaseUrl}/api/lti/webhook` : "(PUBLIC_URL not set)",
    },
    store: {
      ...stats,
      note:
        "In-memory. A deploy restarts the service and empties this, which is " +
        "why a launch from before a deploy can no longer be matched.",
    },
    detail: authorised
      ? "full"
      : diagKey
        ? "restricted — add ?key=<LTI_DIAG_KEY>"
        : "restricted — set LTI_DIAG_KEY to see launches and events",
  };

  if (!authorised) return json(summary);

  return json({
    ...summary,
    launches: launchSummaries(),
    events: recentLtiEvents(),
  });
};
