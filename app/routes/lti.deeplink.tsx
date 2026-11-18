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
 * WHY THE FORMS ARE PLAIN <form> POSTING TO A DIFFERENT ROUTE
 * ------------------------------------------------------------
 * The deep-linking response must reach the platform as a real browser form
 * POST to ITS url, carrying the admin's own session. So the submit handler
 * returns an HTML document that auto-submits, and that CANNOT live in this
 * route: this file has a default export, which makes it a UI route, and a UI
 * route's action return value is treated as action data -- Remix then re-runs
 * the loaders and re-renders this component, discarding the document. The
 * symptom was a button that appeared to do nothing while the picker quietly
 * re-rendered with cleared fields.
 *
 * The submit handler therefore lives in `lti.deeplink_.submit.ts`, a resource
 * route, which returns its Response verbatim. These forms are plain <form>
 * elements rather than Remix's <Form> so the browser performs a native
 * submission and nothing intercepts it.
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
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { getDeepLink } from "~/.server/lti/deeplink-store";
import { sourceCatalog, sourcePortal } from "~/.server/lti/portal";

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

/** Resource route: a UI route's action cannot return a raw HTML document. */
const SUBMIT_URL = "/lti/deeplink/submit";

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
      <form
        method="post"
        action={SUBMIT_URL}
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
            placeholder="paste course id, e.g. 6dcd9527-3d0f-..."
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
            placeholder="title to show in this portal"
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
      </form>

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
            <form method="post" action={SUBMIT_URL}>
              <input type="hidden" name="dl" value={dlId} />
              <input type="hidden" name="courseId" value={course.id} />
              <input type="hidden" name="courseName" value={course.name} />
              <button type="submit" style={button}>
                Select
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
