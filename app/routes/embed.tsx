/**
 * app/routes/embed.tsx  →  GET /embed
 *
 * A drop-in course player any site can embed with one line:
 *
 *   <iframe src="https://infuse.bryanharrigan.dev/embed"
 *           width="100%" height="640" allowfullscreen></iframe>
 *
 * Optional query params:
 *   ?course=<courseId>  open straight on one course, skipping the catalog
 *   ?q=<text>           pre-fill the catalog search
 *   ?theme=dark         dark surface for dark host pages
 *
 * WHY THE WHOLE WIDGET IS AN IFRAME, NOT A <script> SNIPPET
 * ---------------------------------------------------------
 * Minting a player URL needs INFUSE_API_KEY plus a learner JWT. Anything a
 * <script> snippet can read, every visitor to the host page can read too, so
 * the key could never live there — a script-based widget always needs a
 * backend anyway. Serving the entire widget from our origin instead means:
 *
 *   - no API key anywhere near the browser
 *   - no CORS, no token endpoint to expose, no shared secret with the host
 *   - the learner's Absorb password is typed into OUR origin, so scripts on
 *     the host page (analytics, tag managers, anything injected) cannot read
 *     it — a password field placed directly in a customer's DOM can be
 *   - one line of HTML for whoever installs it, with nothing to configure
 *
 * WHY THIS CAN BE FRAMED FROM ANY DOMAIN
 * --------------------------------------
 * Measured against bryanh.myabsorb.com on 14 Sep 2026:
 *   - the player sends NO Content-Security-Policy, so nothing evaluates the
 *     frame-ancestor chain
 *   - `X-Frame-Options: SAMEORIGIN` appears only on the deny-response for an
 *     invalid token; a valid allow-listed launch omits it entirely (confirmed
 *     by a live cross-origin launch rendering inside infuse.bryanharrigan.dev)
 *
 * Absorb's Allow List check is server-side, from the Referer of the player
 * request. In a nested embed that Referer is always THIS page, whatever site
 * frames us — so one allow-list entry for our domain covers every customer.
 *
 * The 8s watchdog and popup fallback below exist in case Absorb tightens
 * that later; it costs nothing and turns a hard failure into a soft one.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  json,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";

import { embedJwtCookie } from "~/constants/embed-cookie.server";
import { searchEmbedCatalog, type EmbedCourse } from "~/.server/embed-catalog";
import { authenticate } from "~/.server/infuse-api";

/**
 * Nothing in this app sets `X-Frame-Options` (checked: no helmet, no
 * frameguard, nothing in server.js or entry.server), so we must not set one
 * either — being framable by arbitrary sites IS the feature here.
 *
 * An earlier version sent `X-Frame-Options: ""` defensively. Chrome ignores an
 * empty value but logs "Invalid 'X-Frame-Options' header encountered … '' is
 * not a recognized directive", which is noise in every embedding page's
 * console. Send no header at all instead.
 *
 * We also deliberately do NOT send `frame-ancestors`, which would reintroduce
 * the per-domain registration problem this design exists to avoid.
 */
export const headers: HeadersFunction = () => ({
  "Cache-Control": "no-store",
});

type LoaderData = {
  courses: EmbedCourse[];
  query: string;
  signedIn: boolean;
  focusCourseId: string | null;
  theme: "light" | "dark";
  error: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const focusCourseId = url.searchParams.get("course");
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";

  const token = await embedJwtCookie.parse(request.headers.get("Cookie"));

  let courses: EmbedCourse[] = [];
  let error: string | null = null;
  try {
    courses = await searchEmbedCatalog(query);
  } catch (err) {
    // The catalog is the one thing that should never take the widget down
    // silently — surface it rather than rendering an empty grid.
    error =
      "Course catalog is temporarily unavailable. " +
      (err instanceof Error ? err.message : String(err));
  }

  return json<LoaderData>({
    courses,
    query,
    signedIn: Boolean(token),
    focusCourseId,
    theme,
    error,
  });
};

/**
 * Sign in / sign out. Credentials go straight to Absorb's
 * `/authentication` endpoint and are never stored — only the returned JWT is,
 * in an HttpOnly cookie this page's JavaScript cannot read.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "signout") {
    return json(
      { ok: true },
      { headers: { "Set-Cookie": await embedJwtCookie.serialize("", { maxAge: 0 }) } }
    );
  }

  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!username || !password) {
    return json({ ok: false, error: "Enter your username and password." }, { status: 400 });
  }

  try {
    const { token } = await authenticate(username, password);
    return json(
      { ok: true },
      { headers: { "Set-Cookie": await embedJwtCookie.serialize(token) } }
    );
  } catch (err) {
    // Absorb's body can carry internals; keep the learner-facing text generic
    // and leave the detail in the server log that authenticate() already writes.
    console.error(
      "[embed] sign-in failed:",
      err instanceof Error ? err.message : err
    );
    return json(
      { ok: false, error: "That username or password wasn't accepted." },
      { status: 401 }
    );
  }
};

/* ────────────────────────────────── UI ────────────────────────────────── */

type PlayResponse = {
  playerUrl?: string;
  lessonId?: string | null;
  /**
   * False when the minted URL is Absorb's course player, which refuses to
   * frame. Decided server-side because it cannot be detected here — Chrome
   * fires `load` on the refusal page, so a watchdog never trips. See
   * embed_.play.ts.
   */
  framable?: boolean;
  /** Portal URL to open when the content can't be framed. */
  externalUrl?: string;
  /** Set when a curriculum was opened via one of its child courses. */
  partOfCurriculum?: boolean;
  playingCourseName?: string;
  /** Curriculum with no online child — nothing to play inline. */
  notEmbeddable?: boolean;
  reason?: string;
  needsAuth?: boolean;
  needsEnrollment?: boolean;
  error?: string;
};

export default function Embed() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const auth = useFetcher<{ ok: boolean; error?: string }>();
  const play = useFetcher<PlayResponse>();

  const [selected, setSelected] = useState<EmbedCourse | null>(
    () => data.courses.find((c) => c.id === data.focusCourseId) ?? null
  );
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const [frameBlocked, setFrameBlocked] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const signedIn = data.signedIn || auth.data?.ok === true;
  const dark = data.theme === "dark";

  // Launch as soon as we have a course and a session.
  useEffect(() => {
    if (!selected || !signedIn || playerUrl || play.state !== "idle") return;
    if (play.data?.playerUrl || play.data?.error) return;
    play.load(`/embed/play?courseId=${encodeURIComponent(selected.id)}`);
  }, [selected, signedIn, playerUrl, play]);

  useEffect(() => {
    if (play.data?.playerUrl) {
      setPlayerUrl(play.data.playerUrl);
      setFrameLoaded(false);
      // The server already knows whether this URL can be framed. Trust it
      // rather than waiting to find out — otherwise an unframable player
      // shows an empty box for 8 seconds before anything useful appears.
      setFrameBlocked(play.data.framable === false);
    }
  }, [play.data]);

  /**
   * Backstop watchdog for the case where Absorb refuses a URL we expected to
   * work (e.g. the Allow List changes).
   *
   * NOTE: this cannot be the primary mechanism. Chrome fires `load` on the
   * X-Frame-Options refusal page, so `frameLoaded` goes true even when the
   * frame is blocked and this timer is cancelled. `framable` from the server
   * is what actually catches the known case; this only helps when the frame
   * truly hangs.
   */
  useEffect(() => {
    if (!playerUrl || frameLoaded || frameBlocked) return;
    const t = setTimeout(() => setFrameBlocked(true), 8000);
    return () => clearTimeout(t);
  }, [playerUrl, frameLoaded, frameBlocked]);

  const back = () => {
    setSelected(null);
    setPlayerUrl(null);
    setFrameBlocked(false);
    setFrameLoaded(false);
  };

  const onSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get("q");
    const next = new URLSearchParams(searchParams);
    if (q) next.set("q", String(q));
    else next.delete("q");
    setSearchParams(next, { preventScrollReset: true });
  };

  const styles = useMemo(() => embedStyles(dark), [dark]);

  return (
    <div style={styles.root}>
      <style>{GLOBAL_CSS}</style>

      {/* Player */}
      {selected && signedIn && (
        <div style={styles.playerWrap}>
          <div style={styles.bar}>
            <button type="button" onClick={back} style={styles.linkBtn}>
              ← All courses
            </button>
            <span style={styles.barTitle}>
              {selected.name}
              {play.data?.partOfCurriculum && play.data.playingCourseName
                ? ` · ${play.data.playingCourseName}`
                : ""}
            </span>
          </div>

          {play.state !== "idle" && !playerUrl && (
            <p style={styles.muted}>Preparing your course…</p>
          )}

          {play.data?.needsEnrollment && (
            <p style={styles.error}>
              You don't have access to this course yet. Ask your administrator to
              enrol you, then try again.
            </p>
          )}

          {/* Curriculum with nothing playable inline — offer Absorb instead of
              dropping the learner into an empty frame. */}
          {play.data?.notEmbeddable && (
            <div style={styles.fallback}>
              <p style={styles.muted}>{play.data.reason}</p>
              {play.data.externalUrl && (
                <button
                  type="button"
                  style={styles.primaryBtn}
                  onClick={() =>
                    window.open(
                      play.data!.externalUrl,
                      "_blank",
                      "noopener,width=1100,height=760"
                    )
                  }
                >
                  Open in Absorb
                </button>
              )}
            </div>
          )}

          {play.data?.error && !play.data.needsEnrollment && (
            <p style={styles.error}>{play.data.error}</p>
          )}

          {playerUrl && !frameBlocked && (
            <iframe
              ref={frameRef}
              src={playerUrl}
              title={selected.name}
              onLoad={() => setFrameLoaded(true)}
              allowFullScreen
              style={styles.playerFrame}
            />
          )}

          {playerUrl && frameBlocked && (
            <div style={styles.fallback}>
              <p style={styles.muted}>
                This course can't play inside an embedded frame here.
              </p>
              <button
                type="button"
                style={styles.primaryBtn}
                onClick={() => window.open(playerUrl, "_blank", "noopener,width=1100,height=760")}
              >
                Open course in a new window
              </button>
            </div>
          )}
        </div>
      )}

      {/* Sign in — only ever asked for at the moment of playback */}
      {selected && !signedIn && (
        <div style={styles.panel}>
          <button type="button" onClick={back} style={styles.linkBtn}>
            ← All courses
          </button>
          <h2 style={styles.h2}>{selected.name}</h2>
          <p style={styles.muted}>Sign in with your Absorb account to start.</p>

          <auth.Form method="post" style={styles.form}>
            <label style={styles.label}>
              Username
              <input name="username" autoComplete="username" style={styles.input} required />
            </label>
            <label style={styles.label}>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                style={styles.input}
                required
              />
            </label>
            <button type="submit" style={styles.primaryBtn} disabled={auth.state !== "idle"}>
              {auth.state !== "idle" ? "Signing in…" : "Sign in and start"}
            </button>
            {auth.data?.error && <p style={styles.error}>{auth.data.error}</p>}
          </auth.Form>

          {/* So a learner can see whose portal they're handing credentials to,
              even when this widget is framed by a site they don't recognise. */}
          <p style={styles.fineprint}>
            Secured by Absorb · you are signing in to your learning portal
          </p>
        </div>
      )}

      {/* Catalog */}
      {!selected && (
        <div style={styles.panel}>
          <form onSubmit={onSearch} style={styles.searchRow}>
            <input
              name="q"
              defaultValue={data.query}
              placeholder="Search courses…"
              style={{ ...styles.input, flex: 1 }}
              aria-label="Search courses"
            />
            <button type="submit" style={styles.primaryBtn}>
              Search
            </button>
          </form>

          {data.error && <p style={styles.error}>{data.error}</p>}

          {!data.error && data.courses.length === 0 && (
            <p style={styles.muted}>
              {data.query ? `No courses match "${data.query}".` : "No courses available."}
            </p>
          )}

          <div style={styles.grid}>
            {data.courses.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelected(c)}
                style={styles.card}
                className="embed-card"
              >
                {c.imageUrl ? (
                  <img src={c.imageUrl} alt="" style={styles.thumb} loading="lazy" />
                ) : (
                  <div style={{ ...styles.thumb, ...styles.thumbEmpty }} />
                )}
                <span style={styles.cardTitle}>{c.name}</span>
                <span style={styles.cardType}>{labelForType(c.courseType)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function labelForType(t: EmbedCourse["courseType"]): string {
  if (t === "OnlineCourse") return "Online course";
  if (t === "InstructorLedCourse") return "Instructor-led";
  return "Curriculum";
}

const GLOBAL_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .embed-card { cursor: pointer; transition: transform .12s ease, box-shadow .12s ease; }
  .embed-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.14); }
  .embed-card:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
`;

function embedStyles(dark: boolean) {
  const fg = dark ? "#f3f4f6" : "#111827";
  const muted = dark ? "#9ca3af" : "#6b7280";
  const bg = dark ? "#0f172a" : "#ffffff";
  const surface = dark ? "#1e293b" : "#f9fafb";
  const border = dark ? "#334155" : "#e5e7eb";

  const base: Record<string, React.CSSProperties> = {
    root: {
      font: "14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      color: fg,
      background: bg,
      height: "100%",
      display: "flex",
      flexDirection: "column",
      boxSizing: "border-box",
    },
    panel: { padding: 16, overflowY: "auto", flex: 1 },
    playerWrap: { display: "flex", flexDirection: "column", height: "100%" },
    bar: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "10px 14px",
      borderBottom: `1px solid ${border}`,
      flex: "0 0 auto",
    },
    barTitle: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    playerFrame: { flex: 1, width: "100%", border: 0, minHeight: 320 },
    fallback: { padding: 24, textAlign: "center" },
    searchRow: { display: "flex", gap: 8, marginBottom: 16 },
    grid: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
      gap: 14,
    },
    card: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      padding: 10,
      textAlign: "left",
      background: surface,
      border: `1px solid ${border}`,
      borderRadius: 10,
      color: fg,
      font: "inherit",
    },
    thumb: { width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 6 },
    thumbEmpty: { background: dark ? "#334155" : "#e5e7eb" },
    cardTitle: { fontWeight: 600, fontSize: 14 },
    cardType: { fontSize: 12, color: muted },
    h2: { margin: "12px 0 4px", fontSize: 18 },
    form: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 320, marginTop: 16 },
    label: { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: muted },
    input: {
      padding: "9px 11px",
      border: `1px solid ${border}`,
      borderRadius: 8,
      background: bg,
      color: fg,
      font: "inherit",
    },
    primaryBtn: {
      padding: "9px 16px",
      border: 0,
      borderRadius: 8,
      background: "#2563eb",
      color: "#fff",
      font: "inherit",
      fontWeight: 600,
      cursor: "pointer",
    },
    linkBtn: {
      background: "none",
      border: 0,
      padding: 0,
      color: "#2563eb",
      font: "inherit",
      cursor: "pointer",
    },
    muted: { color: muted },
    error: { color: "#dc2626" },
    fineprint: { marginTop: 20, fontSize: 12, color: muted },
  };
  return base;
}
