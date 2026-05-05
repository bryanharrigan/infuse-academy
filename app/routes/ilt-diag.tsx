/**
 * app/routes/ilt-diag.tsx
 *
 * Probe a list of Absorb V2 endpoints that might return:
 *   1. The learner's ILT registrations (since /my-courses doesn't
 *      include them for this tenant).
 *   2. Per-lesson progress data with completedDate (since the chapters
 *      endpoint we use returns lesson titles only, no progress).
 *
 * Returns status / topKeys / first-record summary for each candidate so
 * we can pick the working one and pin it in the loader.
 */

import { LoaderFunctionArgs, json } from "@remix-run/node";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";

const InfuseApiKey = process.env.INFUSE_API_KEY ?? "";
const InfuseBaseUrl = process.env.INFUSE_BASE_URL ?? "";
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
  topKeys: string[];
  embeddedKeys: string[] | null;
  itemCount: number;
  firstItemKeys: string[] | null;
  firstItemPreview: Record<string, unknown> | null;
  rawHead: string;
};

async function probe(
  url: string,
  headers: HeadersInit
): Promise<Probe> {
  try {
    const r = await fetch(url, { method: "GET", headers });
    const text = await r.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* ignore */
    }
    let topKeys: string[] = [];
    let embeddedKeys: string[] | null = null;
    let itemCount = 0;
    let firstItemKeys: string[] | null = null;
    let firstItemPreview: Record<string, unknown> | null = null;
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      topKeys = Object.keys(d);
      const embedded = d._embedded as Record<string, unknown> | undefined;
      if (embedded) embeddedKeys = Object.keys(embedded);
      // Try to find an array of items
      const candidates: unknown[] = [];
      const collect = (v: unknown) => {
        if (Array.isArray(v)) candidates.push(v);
      };
      collect(d.items);
      if (embedded) {
        for (const v of Object.values(embedded)) collect(v);
      }
      collect((d as { sessions?: unknown }).sessions);
      collect((d as { enrollments?: unknown }).enrollments);
      collect((d as { lessons?: unknown }).lessons);
      const arr = candidates.find((c): c is unknown[] => Array.isArray(c));
      if (Array.isArray(arr)) {
        itemCount = arr.length;
        if (arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null) {
          const first = arr[0] as Record<string, unknown>;
          firstItemKeys = Object.keys(first);
          firstItemPreview = {};
          for (const k of firstItemKeys.slice(0, 16)) {
            const v = first[k];
            if (v === null || v === undefined) continue;
            if (typeof v === "string")
              firstItemPreview[k] = v.slice(0, 100);
            else if (typeof v === "number" || typeof v === "boolean")
              firstItemPreview[k] = v;
            else firstItemPreview[k] = `[${typeof v}]`;
          }
        }
      }
    }
    return {
      url,
      status: r.status,
      topKeys,
      embeddedKeys,
      itemCount,
      firstItemKeys,
      firstItemPreview,
      rawHead: text.slice(0, 400),
    };
  } catch (err) {
    return {
      url,
      status: 0,
      topKeys: [],
      embeddedKeys: null,
      itemCount: 0,
      firstItemKeys: null,
      firstItemPreview: null,
      rawHead: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  if (!token) return json({ error: "unauthorized" }, { status: 401 });

  const legacyBase = InfuseBaseUrl.replace(/\/$/, "");
  const infuseBase = InfuseApiUrl.replace(/\/$/, "");

  // ILT registrations — try every plausible endpoint
  const iltUrls = [
    `${legacyBase}/my-session-enrollments?_limit=20`,
    `${legacyBase}/my-courses?courseTypes=InstructorLedCourse&_limit=20`,
    `${legacyBase}/my-courses?courseTypes=InstructorLedCourse&showCompleted=true&_limit=20`,
    `${legacyBase}/my-course-enrollments?_limit=20`,
    `${legacyBase}/my-course-enrollments?courseTypes=InstructorLedCourse&_limit=20`,
    `${legacyBase}/my-instructor-led-enrollments?_limit=20`,
    `${legacyBase}/my-classroom-enrollments?_limit=20`,
  ];

  // Per-lesson progress — try alternatives for lesson completion data
  // Pick a known online course (we'll use the first chapters fetch result)
  const sampleCourseId = "b6e3d500-ae22-47e9-bae5-9a8933dfe042"; // Branching
  const lessonUrls = [
    // Legacy v2
    `${legacyBase}/my-course-enrollments/${sampleCourseId}/lesson-progresses?_limit=20`,
    `${legacyBase}/my-course-enrollments/${sampleCourseId}/lessons?_limit=20`,
    `${legacyBase}/my-courses/${sampleCourseId}/lessons?_limit=20`,
    `${legacyBase}/my-courses/${sampleCourseId}/chapters?_limit=20`,
    `${legacyBase}/lesson-progresses?courseId=${sampleCourseId}&_limit=20`,
    // Infuse API host
    `${infuseBase}/online-courses/${sampleCourseId}/chapters`,
    `${infuseBase}/my-online-courses/${sampleCourseId}/chapters`,
    `${infuseBase}/my-online-course-enrollments/${sampleCourseId}/chapters`,
  ];

  const [ilt, lessons] = await Promise.all([
    Promise.all(iltUrls.map((u) => probe(u, legacyHeaders(token)))),
    Promise.all(
      lessonUrls.map((u, i) =>
        probe(u, i >= 5 ? infuseHeaders(token) : legacyHeaders(token))
      )
    ),
  ]);

  return json({
    iltProbes: ilt,
    lessonProbes: lessons,
    notes: [
      "Look for status: 200 with itemCount > 0 in iltProbes — that's the right ILT endpoint.",
      "In lessonProbes, look for fields like progress, completedDate, status on the firstItemKeys.",
    ],
  });
}
