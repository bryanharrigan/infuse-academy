/**
 * app/routes/_curriculum-diag.$courseId.ts
 *
 * Throwaway diagnostic route — hits a long list of Absorb V2 + Infuse API
 * endpoints that *might* return the child courses of a Curriculum, then
 * reports the status code, response length, and a JSON outline for each.
 *
 * Once we know which endpoint actually serves the children for this
 * tenant, we hard-code it in `getCurriculumChildren` and delete this
 * file. Ship it, hit /\_curriculum-diag/<curriculumId>, paste the output,
 * and we lock in the right URL.
 *
 * Path is underscore-prefixed so Remix file-based routing keeps it tucked
 * out of the way and won't accidentally match a real /curriculum-diag/...
 * URL the learner might land on.
 */

import { LoaderFunctionArgs, json } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";

const InfuseApiKey = process.env.INFUSE_API_KEY ?? "";
const InfuseBaseUrl = process.env.INFUSE_BASE_URL ?? ""; // bryanh.myabsorb.com/api/rest/v2
const InfuseApiUrl =
  process.env.INFUSE_API_URL ?? "https://infuse.myabsorb.com";

function legacyHeaders(token: string): HeadersInit {
  return {
    "X-Absorb-API-Key": InfuseApiKey,
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
}

function infuseHeaders(token: string): HeadersInit {
  return {
    "x-api-key": InfuseApiKey,
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
}

type Probe = {
  url: string;
  status: number;
  ok: boolean;
  bodyLen: number;
  topKeys: string[];
  embeddedKeys: string[] | null;
  coursesLen: number;
  bodyHead: string;
};

async function probe(
  url: string,
  headers: HeadersInit
): Promise<Probe> {
  try {
    const r = await fetch(url, { method: "GET", headers });
    const text = await r.text();
    let topKeys: string[] = [];
    let embeddedKeys: string[] | null = null;
    let coursesLen = 0;
    try {
      const data = JSON.parse(text);
      topKeys = Object.keys(data ?? {});
      embeddedKeys = data?._embedded ? Object.keys(data._embedded) : null;
      const candidates =
        data?._embedded?.courses ??
        data?.courses ??
        data?._embedded?.["courses"] ??
        data?._embedded?.children ??
        data?.children ??
        [];
      if (Array.isArray(candidates)) coursesLen = candidates.length;
    } catch {
      // Non-JSON body — leave topKeys empty
    }
    return {
      url,
      status: r.status,
      ok: r.ok,
      bodyLen: text.length,
      topKeys,
      embeddedKeys,
      coursesLen,
      bodyHead: text.slice(0, 240),
    };
  } catch (err) {
    return {
      url,
      status: 0,
      ok: false,
      bodyLen: 0,
      topKeys: [],
      embeddedKeys: null,
      coursesLen: 0,
      bodyHead: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const courseId = params.courseId;
  if (!courseId) {
    return json({ error: "courseId required" }, { status: 400 });
  }

  // Build candidate list — includes both API hosts and a variety of
  // pluralisations / nestings. The diagnostic route just runs them all
  // and reports back; the production helper will get pinned to whichever
  // one actually returns child courses.
  const legacyBase = InfuseBaseUrl.replace(/\/$/, "");
  const infuseBase = InfuseApiUrl.replace(/\/$/, "");
  const id = encodeURIComponent(courseId);

  const legacyUrls = [
    `${legacyBase}/curricula/${id}`,
    `${legacyBase}/curricula/${id}/courses?_limit=30`,
    `${legacyBase}/curricula/${id}/groups?_limit=30`,
    `${legacyBase}/my-curricula/${id}`,
    `${legacyBase}/my-curricula/${id}/courses?_limit=30`,
    `${legacyBase}/my-courses/${id}`,
    `${legacyBase}/my-courses/${id}/courses?_limit=30`,
    `${legacyBase}/my-courses?curriculumId=${id}&_limit=30`,
    `${legacyBase}/my-courses?_filter=curriculumId%3D${id}&_limit=30`,
    `${legacyBase}/my-course-enrollments/${id}`,
    `${legacyBase}/my-course-enrollments/${id}/courses?_limit=30`,
    `${legacyBase}/my-course-enrollments?curriculumId=${id}`,
    `${legacyBase}/curriculum-enrollments/${id}/courses?_limit=30`,
  ];

  const infuseUrls = [
    `${infuseBase}/curricula/${id}/courses?_limit=30`,
    `${infuseBase}/curricula/${id}`,
    `${infuseBase}/online-courses/${id}/chapters`,
    `${infuseBase}/my-curricula/${id}/courses?_limit=30`,
  ];

  const [legacy, infuse] = await Promise.all([
    Promise.all(legacyUrls.map((u) => probe(u, legacyHeaders(token)))),
    Promise.all(infuseUrls.map((u) => probe(u, infuseHeaders(token)))),
  ]);

  return json({
    courseId,
    legacy,
    infuse,
    notes: [
      "Look for any row with status 200 + coursesLen > 0.",
      "If a 200 returns embedded with non-courses keys, paste those keys.",
    ],
  });
}
