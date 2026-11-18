/**
 * app/routes/lti.deeplink.tsx  ->  GET and POST /lti/deeplink
 *
 * The content picker the host portal's admin sees when they click "Add
 * Content" on an LTI Learning Object.
 *
 * GET  - list the source portal's Online Courses, plus a box for pasting a
 *        course id directly.
 * POST - sign an LtiDeepLinkingResponse for the chosen course and auto-submit
 *        it back to the platform, which then stores the resource link.
 *
 * WHY THE FORMS USE reloadDocument
 * --------------------------------
 * The deep-linking response has to reach the platform as a real browser form
 * POST to ITS url, carrying whatever session it keeps for the admin. So this
 * action returns an HTML document with a self-submitting form rather than
 * data. Remix's client router intercepts a normal <Form method="post">,
 * fetches the action and expects data or a redirect back - it has nowhere to
 * put an HTML document, so the submit appeared to do nothing at all.
 * `reloadDocument` makes the browser perform a native submit, so the returned
 * document is rendered and its onload submit runs. Do not remove it.
 *
 * WHY THERE IS A MANUAL COURSE ID BOX
 * -----------------------------------
 * The catalog list comes from `/my-catalog` on the source portal using only
 * the API key. Some tenants scope that endpoint to an identity even with the
 * key present, so it can return a small subset - on bryanh.myabsorb.com it
 * returned 2 courses on 18 Nov while the course we actually wanted was not
 * among them. Rather than block on catalog visibility, paste the id. The
 * course id is what the resource link carries either way; the list is a
 * convenience, not the mechanism.
 *
 * ONLINE COURSES ONLY. The catalog query filters to OnlineCourse before the
 * admin sees it. A pasted id is trusted as-is, so paste an Online Course: a
 * curriculum or instructor-led course will fail later, at play time.
 */

import { useState } from "react";
import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

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

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function problem(message: string, status = 400): Response {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Could not add content</title></head>
<body style="font-family:system-ui;padding:2rem;max-width:40rem">
  <h1 style="font-size:1.1rem">Could not add this content</h1>
  <p style="color:#555">${escapeHtml(message)}</p>
  <p><button onclick="history.back()">Go back</button></p>
</body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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
    return problem("No course was selected and no course id was entered.");
  }
  if (!GUID.test(courseId)) {
    return problem(
      `"${courseId}" is not an Absorb course id. It should look like ` +
        `6dcd9527-3d0f-469c-8753-2f28bdbc8de4.`
    );
  }

  const platform = allPlatforms().find((p) => p.id === dl.platformId);
  if (!platform) {
    return problem("Platform registration not found.", 500);
  }

  const now = Math.floor(Date.now() / 1000);

  /**
   * `custom.absorb_course_id` is what comes back to us on every subsequent
   * learner launch - it is the entire link between the host portal's Learning
   * Object and the source portal's course, and it OVERRIDES any course id set
   * in the tool registration's Custom Fields for this link.
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
    `[lti/deeplink] returning content item course=${courseId} to ${platform.id}`
  );

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Returning your selection...</title></head>
<body onload="document.forms[0].submit()" style="font-family:system-ui;padding:2rem">
  <p>Returning your selection to the portal...</p>
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

const card: React.CSSProperties = {
  border: "1px solid #e3e3e3",
  borderRadius: 6,
  padding: ".85rem 1rem",
  marginBottom: ".5rem",
  display: "flex",
  gap: "1rem",
  alignItems: "center",
};

const button: React.CSSProperties = {
  padding: ".5rem 1rem",
  border: 0,
  borderRadius: 6,
  background: "#1d4ed8",
  color: "#fff",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export default function DeepLinkPicker() {
  const { dlId, courses, error } = useLoaderData<typeof loader>();
  const [query, setQuery] = useState("");
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");

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
            marginBottom: "1rem",
          }}
        >
          <strong>Could not load the catalog.</strong>
          <div style={{ marginTop: ".5rem", fontSize: ".9rem" }}>{error}</div>
        </div>
      ) : null}

      {/* Paste-an-id escape hatch. The catalog is read with the API key alone,
          which some tenants scope to a subset, so the list can be short or
          missing the course you want. */}
      <Form
        method="post"
        reloadDocument
        style={{
          border: "1px solid #d9d9d9",
          background: "#fafafa",
          borderRadius: 6,
          padding: "1rem",
          marginBottom: "1.25rem",
        }}
      >
        <input type="hidden" name="dl" value={dlId} />
        <div style={{ fontWeight: 600, marginBottom: ".35rem" }}>
          Or enter a course id
        </div>
        <div style={{ color: "#666", fontSize: ".85rem", marginBottom: ".6rem" }}>
          Use this if the course is not listed below. Find the id in the source
          portal&apos;s course URL. Online courses only.
        </div>
        <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
          <input
            name="courseId"
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
            placeholder="6dcd9527-3d0f-469c-8753-2f28bdbc8de4"
            style={{
              flex: "2 1 22rem",
              padding: ".55rem .7rem",
              border: "1px solid #ccc",
              borderRadius: 6,
              fontFamily: "ui-monospace, monospace",
            }}
          />
          <input
            name="courseName"
            value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            placeholder="Title to show in this portal"
            style={{
              flex: "1 1 14rem",
              padding: ".55rem .7rem",
              border: "1px solid #ccc",
              borderRadius: 6,
            }}
          />
          <button type="submit" style={button}>
            Use this id
          </button>
        </div>
      </Form>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Filter ${courses.length} course${courses.length === 1 ? "" : "s"}...`}
        style={{
          width: "100%",
          padding: ".6rem .75rem",
          marginBottom: "1rem",
          border: "1px solid #ccc",
          borderRadius: 6,
          fontSize: "1rem",
          boxSizing: "border-box",
        }}
      />

      {filtered.length === 0 && !error ? (
        <p style={{ color: "#777" }}>
          No online courses matched. The list only shows what the source
          portal&apos;s catalog returns for this API key, which may be a subset
          — use the box above if the course you want is missing.
        </p>
      ) : null}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {filtered.map((course) => (
          <li key={course.id} style={card}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{course.name}</div>
              <div
                style={{
                  color: "#999",
                  fontSize: ".75rem",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {course.id}
              </div>
            </div>
            <Form method="post" reloadDocument>
              <input type="hidden" name="dl" value={dlId} />
              <input type="hidden" name="courseId" value={course.id} />
              <input type="hidden" name="courseName" value={course.name} />
              <button type="submit" style={button}>
                Select
              </button>
            </Form>
          </li>
        ))}
      </ul>
    </div>
  );
}
