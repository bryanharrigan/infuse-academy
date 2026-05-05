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

  // ILT registrations — try every plausible endpoint, including
  // showFutureCourses (Absorb sometimes hides upcoming-only enrollments)
  // and the absorb portal's internal /Catalog/MySessions pattern.
  const iltUrls = [
    `${legacyBase}/my-session-enrollments?_limit=20`,
    `${legacyBase}/my-courses?courseTypes=InstructorLedCourse&_limit=20&showCompleted=true&showFutureCourses=true`,
    `${legacyBase}/my-courses?_limit=20&showCompleted=true&showFutureCourses=true`,
    `${legacyBase}/my-courses?_limit=20&showCompleted=true&includeWaitlisted=true`,
    `${legacyBase}/my-bookings?_limit=20`,
    `${legacyBase}/my-classes?_limit=20`,
    `${legacyBase}/instructor-led-courses?_limit=20&showFutureCourses=true`,
    `${legacyBase}/sessions?_limit=20`,
    // Probe a known ILT we've seen — maybe session-enrollments collection
    // on a known course id works.
    `${legacyBase}/my-course-enrollments/ee90b723-c655-4481-9d7d-02b5df07f8c9/session-enrollments?_limit=20`,
    `${legacyBase}/my-course-enrollments/ee90b723-c655-4481-9d7d-02b5df07f8c9?_limit=20`,
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

  // Deep dive into a single online course's chapters → fully unpack
  // each chapter to find where the per-lesson progress fields live.
  let chapterDeepDive: unknown = null;
  try {
    const r = await fetch(
      `${infuseBase}/online-courses/${sampleCourseId}/chapters`,
      { headers: infuseHeaders(token) }
    );
    if (r.ok) {
      const data = (await r.json()) as Record<string, unknown>;
      const embedded = data._embedded as
        | Record<string, unknown>
        | undefined;
      const chapters = (embedded?.chapters ?? []) as Array<
        Record<string, unknown>
      >;
      chapterDeepDive = chapters.map((ch) => {
        const chEmbedded = ch._embedded as Record<string, unknown> | undefined;
        const lessons = (chEmbedded?.lessons ?? []) as Array<
          Record<string, unknown>
        >;
        return {
          chapterId: ch.id,
          chapterName: ch.name,
          chapterTopKeys: Object.keys(ch),
          chapterEnrollment: ch.enrollment,
          lessonCount: lessons.length,
          lessons: lessons.map((l) => ({
            id: l.id,
            name: l.name,
            keys: Object.keys(l),
            progress: l.progress,
            enrollment: l.enrollment,
            // Capture a small preview of every field so we can see what's
            // populated (status, completedDate, etc.).
            preview: Object.fromEntries(
              Object.entries(l)
                .filter(([k]) => k !== "_links" && k !== "_embedded")
                .map(([k, v]) => [
                  k,
                  typeof v === "object" && v !== null
                    ? JSON.stringify(v).slice(0, 200)
                    : v,
                ])
            ),
          })),
        };
      });
    }
  } catch (err) {
    chapterDeepDive = {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return json({
    iltProbes: ilt,
    lessonProbes: lessons,
    chapterDeepDive,
    notes: [
      "iltProbes: status 200 + itemCount > 0 = working ILT endpoint",
      "lessonProbes: status 200 + 'progress' or 'completedDate' in firstItemKeys",
      "chapterDeepDive: shows per-lesson fields including any progress data",
    ],
  });
}
