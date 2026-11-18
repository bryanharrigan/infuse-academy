/**
 * app/routes/lti.deeplink_.submit.ts  ->  POST /lti/deeplink/submit
 *
 * Signs an LtiDeepLinkingResponse for the chosen course and returns an HTML
 * document that auto-submits it to the platform's deep_link_return_url.
 *
 * WHY THIS IS A SEPARATE ROUTE FROM THE PICKER
 * --------------------------------------------
 * This must be a RESOURCE route -- no default export. `lti.deeplink.tsx` has
 * a component, which makes it a UI route, and a UI route's action cannot
 * return a raw HTML document: Remix treats whatever the action returns as
 * action data, then re-runs the loaders and re-renders the component. The
 * signed response was being built correctly and then discarded, and the
 * picker simply re-rendered with cleared fields -- which looked exactly like
 * "the button does nothing".
 *
 * A resource route returns its Response verbatim, which is what the deep-link
 * handshake needs: the browser must render our page so its onload submit can
 * POST to the platform, carrying the admin's own session with it.
 *
 * The trailing underscore in `lti.deeplink_` opts this out of nesting under
 * `lti.deeplink.tsx`, the same way `embed_.play.ts` does for the embed.
 *
 * Absorb's picker is watching for this: its parent page polls the iframe's
 * document and gets a cross-origin SecurityError on every tick while the
 * iframe is on our origin. The handshake ends when our auto-submit navigates
 * that iframe back to bharrigan.myabsorb.ca, at which point the parent can
 * read it and close the modal.
 */

import type { ActionFunctionArgs } from "@remix-run/node";

import { CLAIM, MESSAGE_TYPE } from "~/.server/lti/claims";
import { getDeepLink } from "~/.server/lti/deeplink-store";
import { signToolJwt } from "~/.server/lti/jwt";
import { ToolBaseUrl } from "~/.server/lti/keys";
import { allPlatforms } from "~/.server/lti/platforms";
import { randomId } from "~/.server/lti/store";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>LTI</title></head>${body}</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function problem(message: string, status = 400): Response {
  return html(
    `<body style="font-family:system-ui;padding:2rem;max-width:40rem">
  <h1 style="font-size:1.1rem">Could not add this content</h1>
  <p style="color:#555">${escapeHtml(message)}</p>
  <p><button onclick="history.back()">Go back</button></p>
</body>`,
    status
  );
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const dlId = String(form.get("dl") ?? "");
  const courseId = String(form.get("courseId") ?? "").trim();
  const courseName =
    String(form.get("courseName") ?? "").trim() || "Absorb course";

  const dl = getDeepLink(dlId);
  if (!dl) {
    return problem(
      "This picker session has expired. Close this window and click Add Content again.",
      410
    );
  }
  if (!courseId) {
    return problem(
      "No course id was provided. Either pick a course from the list or paste " +
        "an id into the box -- the greyed-out text in that box is an example, " +
        "not a value."
    );
  }
  if (!GUID.test(courseId)) {
    return problem(
      `"${courseId}" is not an Absorb course id. It should look like ` +
        `6dcd9527-3d0f-469c-8753-2f28bdbc8de4.`
    );
  }

  const platform = allPlatforms().find((p) => p.id === dl.platformId);
  if (!platform) return problem("Platform registration not found.", 500);

  const now = Math.floor(Date.now() / 1000);

  /**
   * `custom.absorb_course_id` is what comes back on every subsequent learner
   * launch -- it is the entire link between the host portal's Learning Object
   * and the source portal's course, and it OVERRIDES any course id set in the
   * tool registration's Custom Fields for this particular link.
   *
   * `lineItem` asks the platform to create a grade column so AGS has somewhere
   * to post. Without it the launch arrives with no `lineitem` claim and
   * completions have nowhere to go.
   */
  const contentItem = {
    type: "ltiResourceLink",
    title: courseName,
    url: `${ToolBaseUrl}/lti/launch`,
    custom: { absorb_course_id: courseId },
    lineItem: { scoreMaximum: 100, label: courseName },
  };

  const payload: Record<string, unknown> = {
    iss: platform.clientId,
    aud: platform.issuer,
    azp: platform.clientId,
    iat: now,
    exp: now + 600,
    nonce: randomId(16),
    [CLAIM.deploymentId]: dl.deploymentId,
    [CLAIM.messageType]: MESSAGE_TYPE.deepLinkingResponse,
    [CLAIM.version]: "1.3.0",
    [CLAIM.contentItems]: [contentItem],
  };
  if (dl.data) payload[CLAIM.deepLinkingData] = dl.data;

  const jwt = signToolJwt(payload);

  console.log(
    `[lti/deeplink] returning content item course=${courseId} title="${courseName}" to ${platform.id}`
  );

  return html(
    `<body onload="document.forms[0].submit()" style="font-family:system-ui;padding:2rem">
  <p>Returning your selection to the portal...</p>
  <form method="POST" action="${escapeHtml(dl.returnUrl)}">
    <input type="hidden" name="JWT" value="${escapeHtml(jwt)}" />
    <noscript><button type="submit">Continue</button></noscript>
  </form>
</body>`
  );
};

/** A GET here is a mistake; say so rather than 405-ing opaquely. */
export const loader = async () =>
  problem("This endpoint only accepts the picker's form submission.", 405);
