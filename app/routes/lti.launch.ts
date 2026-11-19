/**
 * app/routes/lti.launch.ts  →  POST /lti/launch
 *
 * The verified entry point. The platform form-POSTs an `id_token` here; we
 * verify it, work out what kind of launch it is, and redirect.
 *
 * Register this URL in the host portal as the tool's launch / redirect URI.
 * It must match character for character — a trailing slash difference is the
 * usual cause of a launch that dies at the platform with no useful message.
 *
 * TWO MESSAGE TYPES ARRIVE HERE
 * -----------------------------
 *   LtiDeepLinkingRequest → an admin is building the Learning Object and
 *     needs to pick a course. We send them to the picker.
 *   LtiResourceLinkRequest → a learner is launching a course that was already
 *     picked. We send them to the player.
 *
 * Per Absorb's Consumer Mode documentation the admin flow is "Add Content →
 * search or filter the provider's catalog → select one item", so deep linking
 * is the only documented way to create the Learning Object at all. A tool
 * that only handles resource-link launches cannot be configured in Absorb.
 *
 * WHY THIS REDIRECTS INSTEAD OF RENDERING
 * ---------------------------------------
 * POST-then-redirect-then-GET. The player token Absorb mints is single use,
 * so a learner refreshing a page that had rendered the player directly from
 * this POST would get a dead token and a blank frame. Redirecting to a GET
 * that mints fresh on each load makes refresh work, which learners do.
 */

import { redirect, type ActionFunctionArgs } from "@remix-run/node";

import {
  CLAIM,
  MESSAGE_TYPE,
  readAgsEndpoint,
  readCustom,
  readDeepLinkingSettings,
  readIdentity,
  readResourceLinkTitle,
  splitName,
} from "~/.server/lti/claims";
import { verifyPlatformJwt } from "~/.server/lti/jwt";
import { ltiConfigured } from "~/.server/lti/keys";
import { allPlatforms, deploymentAllowed } from "~/.server/lti/platforms";
import {
  consumePendingLogin,
  randomId,
  recordLtiEvent,
  rememberLaunch,
  type LaunchRecord,
} from "~/.server/lti/store";
import { rememberDeepLink } from "~/.server/lti/deeplink-store";

function fail(message: string, status = 400): Response {
  console.warn("[lti/launch] rejected:", message);
  return new Response(`LTI launch failed: ${message}`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Which custom parameter carries the source-portal course id.
 *
 * Our own deep-linking response sets `absorb_course_id`. `course_id` is
 * accepted too so an admin can hand-configure a link if Absorb turns out to
 * offer a manual-URL path alongside the picker.
 */
function courseIdFromCustom(custom: Record<string, string>): string | null {
  return custom.absorb_course_id || custom.course_id || null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!ltiConfigured()) {
    return fail("the tool is not configured — set LTI_TOOL_PRIVATE_KEY and PUBLIC_URL");
  }

  const form = new URLSearchParams(await request.text());
  const idToken = form.get("id_token");
  const state = form.get("state");

  if (!idToken) return fail("no id_token in the launch POST");

  // Single-use: this is what stops a captured launch being replayed.
  const pendingLogin = consumePendingLogin(state);
  if (!pendingLogin) {
    return fail(
      "unknown or already-used state. The launch may have been replayed, or " +
        "the server restarted between login initiation and launch — relaunch " +
        "from the host portal."
    );
  }

  const platform = allPlatforms().find((p) => p.id === pendingLogin.platformId);
  if (!platform) return fail("the platform registration disappeared mid-launch");

  let claims;
  try {
    claims = await verifyPlatformJwt(idToken, {
      jwksUrl: platform.jwksUrl,
      expectedIssuer: platform.issuer,
      expectedAudience: platform.clientId,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 401);
  }

  if (claims.nonce !== pendingLogin.nonce) {
    return fail("id_token nonce does not match the one we issued", 401);
  }

  const version = claims[CLAIM.version];
  if (version !== "1.3.0") {
    return fail(`unsupported LTI version "${String(version)}" — this tool is 1.3 only`);
  }

  const deploymentId =
    typeof claims[CLAIM.deploymentId] === "string"
      ? (claims[CLAIM.deploymentId] as string)
      : undefined;
  if (!deploymentAllowed(platform, deploymentId)) {
    return fail(
      `deployment_id "${deploymentId}" is not allowed for platform ${platform.id}`,
      403
    );
  }
  if (platform.deploymentIds.length === 0) {
    console.log(
      `[lti/launch] ${platform.id} deployment_id="${deploymentId}" — ` +
        `add this to deploymentIds in LTI_PLATFORMS to pin it`
    );
  }

  const messageType = claims[CLAIM.messageType];
  const identity = readIdentity(claims);

  /* ── Admin is choosing content ─────────────────────────────────────────── */
  if (messageType === MESSAGE_TYPE.deepLinkingRequest) {
    const settings = readDeepLinkingSettings(claims);
    if (!settings?.deep_link_return_url) {
      return fail("deep linking request had no deep_link_return_url");
    }
    const dlId = randomId();
    rememberDeepLink({
      dlId,
      platformId: platform.id,
      deploymentId: deploymentId ?? null,
      returnUrl: settings.deep_link_return_url,
      data: settings.data ?? null,
      createdAt: Date.now(),
    });
    console.log(`[lti/launch] ${platform.id} deep-linking request from ${identity.sub}`);
    return redirect(`/lti/deeplink?dl=${encodeURIComponent(dlId)}`);
  }

  /* ── Learner is launching a course ─────────────────────────────────────── */
  if (messageType !== MESSAGE_TYPE.resourceLink) {
    return fail(`unsupported message type "${String(messageType)}"`);
  }

  const custom = readCustom(claims);
  const courseId = courseIdFromCustom(custom);
  if (!courseId) {
    return fail(
      "the resource link carries no Absorb course id. Expected a custom " +
        "parameter `absorb_course_id` — re-create the Learning Object through " +
        "the content picker so it is set."
    );
  }

  // The platform may send structured name claims, a single display name, or
  // neither. Absorb requires both FirstName and LastName, so fall back in
  // that order rather than letting user creation fail on a missing field.
  const names = splitName(identity.name);
  const record: LaunchRecord = {
    launchId: randomId(),
    platformId: platform.id,
    ltiSub: identity.sub,
    deploymentId: deploymentId ?? null,
    ags: readAgsEndpoint(claims),
    identity: {
      iss: platform.issuer,
      sub: identity.sub,
      firstName: identity.firstName ?? names.first,
      lastName: identity.lastName ?? names.last,
      email: identity.email,
    },
    sourceUserId: null,
    sourceCourseId: courseId,
    courseTitle: readResourceLinkTitle(claims),
    learnerToken: null,
    scorePosted: false,
    createdAt: Date.now(),
  };
  rememberLaunch(record);

  console.log(
    `[lti/launch] ${platform.id} resource-link launch: sub=${identity.sub} course=${courseId}`
  );
  recordLtiEvent(
    "launch",
    `resource-link from ${platform.id}: course=${courseId}, ` +
      `AGS line item ${record.ags?.lineitem ? "PRESENT" : "ABSENT"}` +
      (record.ags?.lineitem ? "" : " — completions will have nowhere to post")
  );

  return redirect(`/lti/play?lid=${encodeURIComponent(record.launchId)}`);
};
