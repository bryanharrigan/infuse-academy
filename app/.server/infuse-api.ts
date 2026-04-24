import crypto from "node:crypto";
import { MyCoursesResource } from "./my-courses.resource";
import { MyCourseEnrollment } from "./my-course-enrollment.resource";

const InfuseApiKey = process.env.INFUSE_API_KEY ?? "";

/**
 * Three distinct Absorb hosts — see .env for the full explanation.
 *   InfuseBaseUrl   → legacy tenant Integration API v2 (/my-courses, /authentication)
 *   InfuseApiUrl    → Infuse API (paid add-on): /authentication/basic-authentication-tokens
 *   InfusePortalUrl → tenant portal: /learn/lessonPlayer, /learn/v2/coursePlayer
 */
export const InfuseBaseUrl = process.env.INFUSE_BASE_URL ?? "";
export const InfuseApiUrl =
  process.env.INFUSE_API_URL ?? "https://infuse.myabsorb.com";
export const InfusePortalUrl =
  process.env.INFUSE_PORTAL_URL ??
  InfuseBaseUrl.replace(/\/api\/rest\/v2$/, "");

function joinUrl(
  base: string,
  path: string,
  options?: { params?: Record<string, string> }
) {
  const url = new URL(path, base.endsWith("/") ? base : base + "/");
  if (options?.params) {
    for (const [k, v] of Object.entries(options.params)) url.searchParams.append(k, v);
  }
  return url.href;
}

/** Build a URL against the legacy tenant Integration API (InfuseBaseUrl). */
function infuseUrl(path: string, options?: { params?: Record<string, string> }) {
  return joinUrl(InfuseBaseUrl, path, options);
}

/** Build a URL against the Infuse API paid add-on (InfuseApiUrl). */
function infuseApiUrl(path: string, options?: { params?: Record<string, string> }) {
  return joinUrl(InfuseApiUrl, path, options);
}

function authHeaders(token: string): HeadersInit {
  return { "X-Absorb-API-Key": InfuseApiKey, Authorization: "Bearer " + token, "Content-Type": "application/json" };
}

export type UserProfileResponse = { firstName: string; lastName: string };

export async function authenticate(username: string, password: string): Promise<{ token: string }> {
  const response = await fetch(infuseUrl("authentication"), {
    method: "POST",
    headers: { "X-Absorb-API-Key": InfuseApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, scope: ["learner"] }),
  });
  if (response.status !== 201) throw new Error("Could not authenticate");
  const data = await response.json();
  return { token: data.token };
}

export async function getUserProfile(token: string): Promise<UserProfileResponse> {
  const r = await fetch(infuseUrl("my-profile"), { method: "GET", headers: authHeaders(token) });
  if (r.status !== 200) throw new Error("Error fetching user profile: " + r.status);
  return r.json();
}

export async function getUserAvatar(token: string): Promise<string> {
  const r = await fetch(infuseUrl("my-profile/avatar"), { method: "GET", headers: authHeaders(token) });
  if (r.status !== 200) throw new Error("Error fetching user avatar: " + r.status);
  const data = await r.json();
  return data.avatar;
}

export async function getMyCourses(token: string, options?: { limit?: number; showCompleted?: boolean }): Promise<MyCoursesResource> {
  const r = await fetch(infuseUrl("my-courses", { params: { _limit: String(options?.limit ?? 20), showCompleted: String(options?.showCompleted ?? false), courseTypes: "OnlineCourse" } }), { method: "GET", headers: authHeaders(token) });
  if (r.status !== 200) throw new Error("Error fetching my courses: " + r.status);
  return r.json();
}

export async function getMyCatalog(token: string, options?: { limit?: number; showCompleted?: boolean }): Promise<MyCoursesResource> {
  const r = await fetch(infuseUrl("my-catalog", { params: { _limit: String(options?.limit ?? 20), showCompleted: String(options?.showCompleted ?? false), courseTypes: "OnlineCourse" } }), { method: "GET", headers: authHeaders(token) });
  if (r.status !== 200) throw new Error("Error fetching catalog: " + r.status);
  return r.json();
}

/**
 * Absorb's documented "Encrypted Verifier" for the lesson / course player:
 * HMAC-SHA256 of the verifier string, with an EMPTY key, hex-encoded.
 * This is what `https://www.liavaag.org/English/SHA-Generator/HMAC/` computes
 * with Input=<verifier>, Key="", SHA Variant=SHA-256, Output type=HEX.
 * Refs: Absorb Infuse API docs → Content Playback → Lesson Player →
 * "Generating refresh token".
 *
 *   NOT PKCE S256 (which would be base64url(sha256(verifier))) — Absorb's player
 *   uses HMAC. Easy to get wrong.
 */
function playerChallenge(verifier: string): string {
  return crypto.createHmac("sha256", "").update(verifier).digest("hex");
}

/**
 * The hardcoded verifier used by Absorb's own reference samples and the
 * working WordPress plugin. Absorb recomputes HMAC-SHA256(empty_key,
 * verifier) from this exact value when it receives the player URL, so both
 * sides must agree. The sample apps have shipped this constant for over a
 * year — don't replace with a random value unless Absorb changes their docs.
 */
const HARDCODED_PLAYER_VERIFIER = "a8f5f167f44f4964e6c998dee827110c";

export function newPlayerVerifier(): string {
  return HARDCODED_PLAYER_VERIFIER;
}

/**
 * Mint a one-time refresh token for the course/lesson player.
 *
 *   POST {INFUSE_API_URL}/authentication/basic-authentication-tokens
 *     headers: x-api-key, Authorization: Bearer <tenant JWT>
 *     body:    { challenge, claims: [{ Key: "Learner.Enrollment", Value: courseId }] }
 *
 * - `token` is the tenant JWT from /authentication — no OAuth bridge needed,
 *   matches the working WordPress-plugin reference.
 * - `verifier` is the hardcoded 32-char string Absorb's samples use (see
 *   HARDCODED_PLAYER_VERIFIER). Absorb recomputes HMAC-SHA256(verifier,
 *   empty-key) from the `verifier` query param on the player URL and
 *   compares against our `challenge` here.
 * - The returned refresh token is ONE-TIME USE — mint a new one per launch.
 */
export async function getRefreshTokenForCoursePlayer(
  token: string,
  verifier: string,
  courseId: string
): Promise<string> {
  const challenge = playerChallenge(verifier);
  const url = infuseApiUrl("authentication/basic-authentication-tokens");

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": InfuseApiKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      challenge,
      claims: [{ Key: "Learner.Enrollment", Value: courseId }],
    }),
  });

  const rawBody = await r.text();
  console.log(
    `[infuse-api] basic-authentication-tokens → ${r.status} (${url})  body=${rawBody.slice(0, 300)}`
  );

  if (!r.ok) {
    throw new Error(
      `Failed to get player refresh token: ${r.status} ${rawBody.slice(0, 200)}`
    );
  }
  let data: { token?: string };
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(
      `Refresh token endpoint returned non-JSON body (status ${r.status})`
    );
  }
  if (!data.token) {
    throw new Error(
      `Refresh token endpoint returned 2xx but no token in body: ${rawBody.slice(0, 200)}`
    );
  }
  return data.token;
}

export async function startEnrollment(token: string, courseId: string): Promise<void> {
  const r = await fetch(infuseUrl("my-enrollments"), { method: "POST", headers: authHeaders(token), body: JSON.stringify({ courseId }) });
  if (r.status !== 201) throw new Error("Failed to start enrollment: " + r.status);
}

export type NewsArticle = {
  id: string;
  title: string;
  description?: string;
  content?: string;
  imageUri?: string;
  dateCreated?: string;
  dateModified?: string;
  author?: string;
  authorProfileImageUri?: string;
  hasRead?: boolean;
};

/**
 * Engage News articles for the current learner.
 *   GET {INFUSE_API_URL}/my-news-articles?_limit=&_offset=
 *
 * Returns an array of articles. Absorb wraps them in one of several HAL-ish
 * shapes depending on portal version; we accept all of them.
 *
 * Callers should wrap in try/catch — some tenants don't have the Engage
 * add-on enabled, in which case Absorb returns 403/404.
 */
export async function getNewsArticles(
  token: string,
  options?: { limit?: number; offset?: number }
): Promise<NewsArticle[]> {
  const url = infuseApiUrl("my-news-articles", {
    params: {
      _limit: String(options?.limit ?? 20),
      _offset: String(options?.offset ?? 0),
    },
  });
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": InfuseApiKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });
  console.log(`[infuse-api] GET /my-news-articles → ${r.status}`);
  if (!r.ok) {
    throw new Error("Error fetching news articles: " + r.status);
  }
  const data = await r.json();
  // Shape can be `newsArticles`, `_embedded.newsArticles`, or
  // `_embedded.news-articles` — match the WP reference.
  return (
    data?.newsArticles ??
    data?._embedded?.newsArticles ??
    data?._embedded?.["news-articles"] ??
    []
  );
}

export async function getMyCourseEnrollment(token: string, courseId: string): Promise<MyCourseEnrollment> {
  const r = await fetch(infuseUrl("my-course-enrollments/" + courseId), { method: "GET", headers: authHeaders(token) });
  if (r.status === 200) {
    const d = await r.json();
    return { progress: d.progress, enrollmentStatus: d.enrollmentStatus, enrollmentDate: d.enrollmentDate, completionDate: d.completionDate };
  }
  throw new Error("Enrollment check failed: " + r.status);
}

export type Lesson = {
  id: string;
  name?: string;
  title?: string;
  type?: string;
  progress?: { completedDate?: string | null; status?: string };
};

export type Chapter = {
  id: string;
  name?: string;
  title?: string;
  _embedded?: { lessons?: Lesson[] };
};

/**
 * Fetch chapters + their embedded lessons for a course via the Infuse API.
 *
 *   GET /online-courses/{id}/chapters     ← NOTE: `online-courses`, not `courses`
 *   Host: infuse.myabsorb.com
 *   Headers: x-api-key, Authorization: Bearer <tenant JWT>
 *
 * Response is HAL-shaped:
 *   { _embedded: { chapters: [ { ..., _embedded: { lessons: [...] } }, ... ] } }
 *
 * The `token` parameter is the plain tenant JWT from /authentication — no
 * OAuth bridge needed. Matches the working WordPress-plugin reference.
 */
export async function getChaptersForCourse(
  token: string,
  courseId: string
): Promise<Chapter[]> {
  const url = infuseApiUrl("online-courses/" + courseId + "/chapters");
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": InfuseApiKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });
  const rawBody = await r.text();
  console.log(
    `[infuse-api] GET /online-courses/:id/chapters → ${r.status} (${url})`
  );
  if (!r.ok) {
    throw new Error(
      `Failed to fetch chapters: ${r.status} ${rawBody.slice(0, 200)}`
    );
  }
  try {
    const data = JSON.parse(rawBody);
    return data?._embedded?.chapters ?? [];
  } catch {
    return [];
  }
}

/**
 * Flatten chapters to a list of lessons in chapter order.
 */
export function lessonsFromChapters(chapters: Chapter[]): Lesson[] {
  return chapters.flatMap((c) => c._embedded?.lessons ?? []);
}

function isLessonComplete(lesson: Lesson): boolean {
  const s = lesson.progress?.status?.toLowerCase() ?? "";
  return s === "complete" || s === "completed" || Boolean(lesson.progress?.completedDate);
}

/**
 * Pick the lesson the user should resume on — first not-complete, or fall back to the first one.
 */
export function nextLesson(chapters: Chapter[]): Lesson | null {
  const all = lessonsFromChapters(chapters);
  return all.find((l) => !isLessonComplete(l)) ?? all[0] ?? null;
}

export type LessonPlayerPayload = {
  playerUrl: string;
  courseId: string;
  lessonId: string | null;
  verifier: string;
  /** True if we had to pick a lesson because the caller didn't specify one. */
  pickedLesson: boolean;
  /**
   * Full chapter/lesson tree. Only populated when mode="course" so the client
   * can render a sidebar — omitted in default "lesson" mode to keep the
   * payload minimal.
   */
  chapters?: Chapter[];
};

/**
 * End-to-end: for a given course, produce the Absorb player URL the front-end
 * can drop into an iframe or popup.
 *
 *   1. Generate a random 32-char codeVerifier (single-use).
 *   2. Exchange the learner bearer + verifier for a one-time refresh token
 *      against the Infuse API host. Scoped to this course enrollment.
 *   3. Build the tenant-portal URL:
 *        - With lessonId supplied → Lesson Player:
 *            {portal}/learn/lessonPlayer?courseId&lessonId&refreshToken&verifier[&returnUrl]
 *        - Without lessonId → Course Player (defaults to first lesson and gives
 *          the learner a chapter-sidebar to navigate between lessons):
 *            {portal}/learn/v2/coursePlayer?courseId&refreshToken&verifier
 *
 * Per Absorb docs, Course Player is recommended for multi-lesson courses;
 * Lesson Player is "best suited for courses which contain a single lesson."
 * We default to Course Player so we never need to pre-fetch the chapter list.
 *
 * NOTE: for iframe embedding, the origin of the page hosting the iframe must
 * be added under Portal Settings → Info → Absorb Allow List. Otherwise the
 * iframe load will be blocked by X-Frame-Options.
 */
/**
 * Build the Absorb player URL for a course. Matches the working WordPress
 * plugin reference (see wordpress-plugin/includes/class-ailms-api.php in the
 * absorb-infuse-code-sample repo):
 *
 *   1. Fetch chapters at /online-courses/{id}/chapters and pick the first
 *      lesson's id.
 *   2. Mint a one-time refresh token at /authentication/basic-authentication-tokens
 *      using the tenant JWT as Bearer.
 *   3. Build:
 *        {portal}/learn/lessonplayer
 *          ?courseId={id}&lessonId={id}&refreshToken={token}&verifier={verifier}&returnUrl=
 *      (lowercase `lessonplayer`, trailing empty `returnUrl=` — yes really.)
 *
 *   If the chapters fetch fails, fall back to the course-level player URL:
 *        {portal}/learn/v2/coursePlayer?courseId=...&refreshToken=...&verifier=...
 *
 * `token` is the plain tenant JWT from /authentication. No OAuth bridge.
 */
export async function getLessonPlayerPayload(
  courseId: string,
  token: string,
  options?: {
    lessonId?: string;
    returnUrl?: string;
    /**
     * "lesson" (default) → return just the URL for the next incomplete lesson.
     * "course"           → also return the full chapter/lesson tree so the
     *   client can render its own sidebar (Absorb's /learn/v2/coursePlayer
     *   refuses to embed in an iframe due to X-Frame-Options, so we always
     *   use /learn/lessonplayer and build the sidebar ourselves).
     */
    mode?: "lesson" | "course";
  }
): Promise<LessonPlayerPayload> {
  const verifier = newPlayerVerifier();
  const mode = options?.mode ?? "lesson";

  // Resolve a lessonId. If the caller provided one, use it. Otherwise fetch
  // chapters and pick the next incomplete lesson. In course-mode we always
  // fetch chapters (to return them for the sidebar); in lesson-mode we only
  // fetch if we need a lessonId.
  let lessonId = options?.lessonId ?? null;
  let pickedLesson = false;
  let chapters: Chapter[] | undefined = undefined;
  const needChapters = mode === "course" || !lessonId;
  if (needChapters) {
    try {
      chapters = await getChaptersForCourse(token, courseId);
      if (!lessonId) {
        const lesson = nextLesson(chapters);
        lessonId = lesson?.id ?? null;
        pickedLesson = Boolean(lessonId);
      }
    } catch (err) {
      console.warn(
        "[infuse-api] getChaptersForCourse failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  const refreshToken = await getRefreshTokenForCoursePlayer(
    token,
    verifier,
    courseId
  );

  const portal = InfusePortalUrl.replace(/\/$/, "");
  const encRefresh = encodeURIComponent(refreshToken);
  const encVerifier = encodeURIComponent(verifier);

  let playerUrl: string;
  if (lessonId) {
    const returnUrl = options?.returnUrl ?? "";
    playerUrl =
      `${portal}/learn/lessonplayer` +
      `?courseId=${courseId}` +
      `&lessonId=${lessonId}` +
      `&refreshToken=${encRefresh}` +
      `&verifier=${encVerifier}` +
      `&returnUrl=${encodeURIComponent(returnUrl)}`;
  } else {
    // No lesson could be resolved (chapters call failed and caller didn't
    // supply one). Fall back to Absorb's Course Player URL — it likely
    // won't embed in an iframe, but the popup fallback will work.
    playerUrl =
      `${portal}/learn/v2/coursePlayer` +
      `?courseId=${courseId}` +
      `&refreshToken=${encRefresh}` +
      `&verifier=${encVerifier}`;
  }

  return {
    playerUrl,
    courseId,
    lessonId,
    verifier,
    pickedLesson,
    chapters: mode === "course" ? chapters : undefined,
  };
}
