/**
 * app/.server/embed-catalog.ts
 *
 * Catalog source for the embeddable widget.
 *
 * WHY THE CATALOG NEEDS NO LEARNER LOGIN
 * --------------------------------------
 * Verified against bryanh.myabsorb.com on 14 Sep 2026, from the portal's
 * own origin with only its guest session:
 *
 *     GET /api/rest/v2/my-catalog   → 200
 *     GET /api/rest/v2/my-courses   → 401
 *     GET /api/rest/v2/my-profile   → 401
 *
 * So the catalog is browsable without a learner identity, while anything
 * learner-specific is not. That is what lets the embed show a real course
 * list immediately and only ask for credentials when someone presses Play.
 *
 * Server-side we authenticate with the API key rather than a guest cookie.
 * Called with no credentials at all the endpoint answers:
 *   401 "Invalid API key. Please provide a valid API key using
 *        'X-Absorb-API-Key' header"
 * — so the key is doing the work here, not anonymity.
 *
 * Some tenants still scope /my-catalog to an identity even with the key
 * present. If the key-only call comes back 401/403 and EMBED_SERVICE_USERNAME
 * / EMBED_SERVICE_PASSWORD are configured, we authenticate as that service
 * account and retry. Configure a service account with catalog-wide
 * visibility if your tenant behaves that way; otherwise leave them unset.
 *
 * WHY THIS IS CACHED RATHER THAN BAKED INTO THE SNIPPET
 * -----------------------------------------------------
 * The obvious shortcut is to paste the course list into the embed snippet.
 * It goes stale the moment a course is added, and there is no way to reach
 * the pages that already have the old snippet pasted in. Caching here gives
 * the same speed and stays current on its own.
 */

import { InfuseBaseUrl, authenticate } from "./infuse-api";
import type { MyCoursesResource } from "./my-courses.resource";

const InfuseApiKey = process.env.INFUSE_API_KEY ?? "";
const ServiceUsername = process.env.EMBED_SERVICE_USERNAME ?? "";
const ServicePassword = process.env.EMBED_SERVICE_PASSWORD ?? "";

/** Absorb rejects _limit above 30 with a 422. */
const PAGE_SIZE = 30;
/** 20 pages ≈ 600 courses. Bounded so a odd tenant can't spin us forever. */
const MAX_PAGES = 20;
/** Long enough to absorb a demo's worth of traffic, short enough to stay fresh. */
const CACHE_TTL_MS = 5 * 60 * 1000;

export type EmbedCourse = {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  courseType: "OnlineCourse" | "InstructorLedCourse" | "Curriculum";
};

type CacheEntry = { courses: EmbedCourse[]; fetchedAt: number };

let cache: CacheEntry | null = null;
/** In-flight promise, so a burst of requests triggers one upstream fetch. */
let inFlight: Promise<EmbedCourse[]> | null = null;

function catalogUrl(offset: number): string {
  const base = InfuseBaseUrl.endsWith("/") ? InfuseBaseUrl : InfuseBaseUrl + "/";
  const url = new URL("my-catalog", base);
  url.searchParams.set("_limit", String(PAGE_SIZE));
  url.searchParams.set("_offset", String(offset));
  url.searchParams.set("_sort", "-ispinned,name");
  url.searchParams.set("showCompleted", "true");
  return url.href;
}

function headers(token?: string): HeadersInit {
  const h: Record<string, string> = {
    "X-Absorb-API-Key": InfuseApiKey,
    "Content-Type": "application/json",
  };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

/** Strip Absorb's HTML description down to something safe to render as text. */
function plainText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAllPages(token?: string): Promise<EmbedCourse[]> {
  const all: EmbedCourse[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetch(catalogUrl(page * PAGE_SIZE), {
      method: "GET",
      headers: headers(token),
    });

    if (r.status === 401 || r.status === 403) {
      const err = new Error(`catalog auth failed: ${r.status}`);
      (err as Error & { authFailure?: boolean }).authFailure = true;
      throw err;
    }
    if (!r.ok) {
      throw new Error(`Error fetching embed catalog: ${r.status}`);
    }

    const data: MyCoursesResource = await r.json();
    const courses = data?._embedded?.courses ?? [];
    if (courses.length === 0) break;

    for (const c of courses) {
      all.push({
        id: c.id,
        name: c.name,
        description: plainText(c.description),
        imageUrl: c.imageUrl,
        courseType: c.courseType,
      });
    }

    if (courses.length < PAGE_SIZE) break;
  }

  return all;
}

async function loadCatalog(): Promise<EmbedCourse[]> {
  try {
    return await fetchAllPages();
  } catch (err) {
    const authFailure = (err as Error & { authFailure?: boolean }).authFailure;
    if (!authFailure || !ServiceUsername || !ServicePassword) throw err;

    // Tenant scopes /my-catalog to an identity — fall back to the service account.
    console.log(
      "[embed-catalog] key-only catalog fetch was rejected; retrying as service account"
    );
    const { token } = await authenticate(ServiceUsername, ServicePassword);
    return await fetchAllPages(token);
  }
}

/**
 * The full catalog, cached for CACHE_TTL_MS.
 *
 * On a refresh failure with a warm cache we serve the stale copy rather than
 * erroring: a transient Absorb blip should not blank out an embed sitting on
 * a customer's page.
 */
export async function getEmbedCatalog(): Promise<EmbedCourse[]> {
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (cache && fresh) return cache.courses;
  if (inFlight) return inFlight;

  inFlight = loadCatalog()
    .then((courses) => {
      cache = { courses, fetchedAt: Date.now() };
      return courses;
    })
    .catch((err) => {
      if (cache) {
        console.error(
          `[embed-catalog] refresh failed (${
            err instanceof Error ? err.message : String(err)
          }); serving cached copy from ${new Date(cache.fetchedAt).toISOString()}`
        );
        return cache.courses;
      }
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Case-insensitive match on name and description, capped for rendering. */
export async function searchEmbedCatalog(
  query: string,
  limit = 24
): Promise<EmbedCourse[]> {
  const all = await getEmbedCatalog();
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);

  const terms = q.split(/\s+/);
  const scored = all
    .map((c) => {
      const name = c.name.toLowerCase();
      const desc = c.description.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (name.includes(t)) score += name.startsWith(t) ? 3 : 2;
        else if (desc.includes(t)) score += 1;
        else return null; // every term must match somewhere
      }
      return { c, score };
    })
    .filter((x): x is { c: EmbedCourse; score: number } => x !== null)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((x) => x.c);
}

export async function getEmbedCourse(id: string): Promise<EmbedCourse | null> {
  const all = await getEmbedCatalog();
  return all.find((c) => c.id === id) ?? null;
}
