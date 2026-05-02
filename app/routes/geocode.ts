/**
 * app/routes/geocode.ts
 *
 * Server-side proxy for OpenStreetMap's Nominatim geocoder. Required
 * because Nominatim's CORS rules and usage policy push the request
 * through a server with a meaningful User-Agent header.
 *
 *   GET /geocode?q={address}
 *
 * Returns:
 *   200 { lat: number, lon: number, displayName: string }
 *   404 { error: "no result" }            — Nominatim returned []
 *   500 { error: "<message>" }            — fetch failed
 *
 * Used by the MapModal to convert a free-form venue address into
 * lat/lon for the OSM embed iframe (which needs a bbox + marker).
 *
 * Caches in-memory per server instance for 24h to keep us well within
 * Nominatim's 1-request-per-second policy. The cache map is bounded
 * because the catalog has finite venues, but evicts oldest entries
 * once it grows past 256 keys.
 */

import { LoaderFunctionArgs, json } from "@remix-run/node";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT =
  "InfuseLearningHub/1.0 (https://infuse.bryanharrigan.dev; contact: bryan.harrigan@gmail.com)";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CACHE_MAX = 256;
type CacheEntry = {
  lat: number;
  lon: number;
  displayName: string;
  expires: number;
};
const cache = new Map<string, CacheEntry>();

function getFromCache(key: string): CacheEntry | null {
  const v = cache.get(key);
  if (!v) return null;
  if (v.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  // Touch to keep this key fresh in insertion order (Map preserves
  // insertion order — re-inserting moves the key to the back).
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function putInCache(key: string, value: Omit<CacheEntry, "expires">) {
  if (cache.size >= CACHE_MAX) {
    // Evict the oldest key (Map iteration order = insertion order).
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { ...value, expires: Date.now() + CACHE_TTL_MS });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  if (!q || q.trim().length === 0) {
    return json({ error: "q required" }, { status: 400 });
  }
  const key = q.trim().toLowerCase();
  const cached = getFromCache(key);
  if (cached) {
    return json({
      lat: cached.lat,
      lon: cached.lon,
      displayName: cached.displayName,
      cached: true,
    });
  }

  const upstream = new URL(NOMINATIM_URL);
  upstream.searchParams.set("q", q);
  upstream.searchParams.set("format", "json");
  upstream.searchParams.set("limit", "1");
  upstream.searchParams.set("addressdetails", "0");

  try {
    const r = await fetch(upstream.toString(), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });
    if (!r.ok) {
      return json(
        { error: `Nominatim returned ${r.status}` },
        { status: 502 }
      );
    }
    const results = (await r.json()) as Array<{
      lat?: string;
      lon?: string;
      display_name?: string;
    }>;
    if (!Array.isArray(results) || results.length === 0) {
      return json({ error: "no result" }, { status: 404 });
    }
    const top = results[0];
    const lat = Number(top.lat);
    const lon = Number(top.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json({ error: "invalid coordinates" }, { status: 502 });
    }
    const payload = {
      lat,
      lon,
      displayName: top.display_name ?? q,
    };
    putInCache(key, payload);
    return json({ ...payload, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 500 });
  }
}
