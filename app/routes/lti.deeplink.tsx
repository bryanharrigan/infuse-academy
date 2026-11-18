/**
 * app/routes/lti.deeplink.tsx  →  GET and POST /lti/deeplink
 *
 * The content picker the host portal's admin sees when they click "Add
 * Content" on an LTI Learning Object.
 *
 * GET  — list the source portal's Online Courses.
 * POST — sign an LtiDeepLinkingResponse for the chosen course and auto-submit
 *        it back to the platform, which then stores the resource link.
 *
 * ONLINE COURSES ONLY. The catalog query filters to OnlineCourse before the
 * admin ever sees it, so there is no way to pick a curriculum or an
 * instructor-led course and produce a link that cannot play.
 */

import { useState } from "react";
import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";

import { CLAIM, MESSAGE_TYPE } from "~/.server/lti/claims";
import { getDeepLink } from "~/.server/lti/deeplink-store";
import { signToolJwt } from "~/.server/lti/jwt";
import { ToolBaseUrl } from "~/.server/lti/keys";
import { allPlatforms } from "~/.server/lti/platforms";
import { sourceCatalog, sourcePortal } from "~/.server/lti/portal";
import { randomId } from "~/.server/lti/store";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const dlId = new URL(request.url).searchParams.get("dl");
  const dl = getDeepLink(dlId);
  if (!dl) {
    throw new Response(
      "This content picker session has expired. Close this window and click " +
        "Add Content again in the host portal.",
      { status: 410 }
    );
  }

  // Use the stored id rather than the raw query param: getDeepLink has
  // already validated it, and this keeps the type non-nullable downstream.
  try {
    const courses = await sourceCatalog(sourcePortal());
    return json({ dlId: dl.dlId, courses, error: null as string | null });
  } catch (err) {
    return json({
      dlId: dl.dlId,
      courses: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const dlId = String(form.get("dl") ?? "");
  const courseId = String(form.get("courseId") ?? "");
  const courseName = String(form.get("courseName") ?? "Absorb course");

  const dl = getDeepLink(dlId);
  if (!dl) {
    return new Response("Picker session expired — reopen Add Content.", {
      status: 410,
    });
  }
  if (!courseId) {
    return new Response("No course was selected.", { status: 400 });
  }

  const platform = allPlatforms().find((p) => p.id === dl.platformId);
  if (!platform) {
    return new Response("Platform registration not found.", { status: 500 });
  }

  const now = Math.floor(Date.now() / 1000);

  /**
   * The content item. `custom.absorb_course_id` is what comes back to us on
   * every subsequent learner launch — it is the entire link between the host
   * portal's Learning Object and the source portal's course.
   *
   * `lineItem` asks the platform to create a grade column so AGS has
   * somewhere to post. Without it the launch arrives with no `lineitem`
   * claim and completions have nowhere to go.
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
  // Echo the platform's opaque value back untouched when it sent one.
  if (dl.data) payload[CLAIM.deepLinkingData] = dl.data;

  const jwt = signToolJwt(payload);

  console.log(
    `[lti/deeplink] returning content item course=${courseId} to ${platform.id}`
  );

  // Auto-submitting form: the response must reach the platform as a POST from
  // the browser, carrying whatever session the platform keeps for the admin.
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Returning your selection…</title></head>
<body onload="document.forms[0].submit()" style="font-family:system-ui;padding:2rem">
  <p>Returning your selection to the portal…</p>
  <form method="POST" action="${escapeHtml(dl.returnUrl)}">
    <input type="hidden" name="JWT" value="${escapeHtml(jwt)}" />
    <noscript><button type="submit">Continue</button></noscript>
  </form>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default function DeepLinkPicker() {
  const { dlId, courses, error } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const [query, setQuery] = useState("");

  const filtered = query
    ? courses.filter((c) =>
        (c.name + " " + c.description).toLowerCase().includes(query.toLowerCase())
      )
    : courses;

  return (
    <div style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 840 }}>
      <h1 style={{ fontSize: "1.25rem", marginBottom: ".25rem" }}>
        Choose a course
      </h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        Online courses from the source Absorb portal. The learner plays the real
        Absorb player; completion reports back to this portal.
      </p>

      {error ? (
        <div
          style={{
            background: "#fdecea",
            border: "1px solid #f5c6cb",
            padding: "1rem",
            borderRadius: 6,
          }}
        >
          <strong>Could not load the catalog.</strong>
          <div style={{ marginTop: ".5rem", fontSize: ".9rem" }}>{error}</div>
        </div>
      ) : null}

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Filter ${courses.length} courses…`}
        style={{
          width: "100%",
          padding: ".6rem .75rem",
          margin: "1rem 0",
          border: "1px solid #ccc",
          borderRadius: 6,
          fontSize: "1rem",
        }}
      />

      {filtered.length === 0 && !error ? (
        <p style={{ color: "#777" }}>No online courses matched.</p>
      ) : null}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {filtered.map((course) => (
          <li
            key={course.id}
            style={{
              border: "1px solid #e3e3e3",
              borderRadius: 6,
              padding: ".85rem 1rem",
              marginBottom: ".5rem",
              display: "flex",
              gap: "1rem",
              alignItems: "center",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{course.name}</div>
              {course.description ? (
                <div
                  style={{
                    color: "#666",
                    fontSize: ".85rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {course.description}
                </div>
              ) : null}
            </div>
            <Form method="post">
              <input type="hidden" name="dl" value={dlId} />
              <input type="hidden" name="courseId" value={course.id} />
              <input type="hidden" name="courseName" value={course.name} />
              <button
                type="submit"
                disabled={navigation.state !== "idle"}
                style={{
                  padding: ".5rem 1rem",
                  border: 0,
                  borderRadius: 6,
                  background: "#1d4ed8",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                Select
              </button>
            </Form>
          </li>
        ))}
      </ul>
    </div>
  );
}
