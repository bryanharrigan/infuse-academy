/**
 * app/routes/lti.play.tsx  →  GET /lti/play?lid=<launchId>
 *
 * Where the learner lands after a verified launch. Provisions them on the
 * source portal, enrols them, mints a player URL and frames it.
 *
 * Reached only by redirect from /lti/launch, which is the only place a
 * `launchId` is minted. Nothing here trusts a query parameter for identity —
 * `lid` is an opaque server-side handle, and the identity it resolves to was
 * fixed at launch from a signature-verified `id_token`.
 *
 * WHY THE WORK HAPPENS ON EVERY GET
 * ---------------------------------
 * Absorb's player refresh token is single use. If this page cached a player
 * URL, a refresh would frame a dead token and show a blank player — which
 * learners would read as "the course is broken". Provisioning is idempotent
 * (stable username, upsert, ReEnroll=false), so redoing it per load is cheap
 * and correct.
 *
 * FRAMING
 * -------
 * The host portal frames us, and we frame the source portal's player: three
 * origins deep. Only `/learn/lessonplayer` frames — `/learn/v2/coursePlayer`
 * sends X-Frame-Options: SAMEORIGIN and never will. When we could not resolve
 * a lesson id we end up on the latter, so the page offers a new window
 * instead of showing a frame that silently refuses to paint.
 *
 * The source portal's Absorb Allow List must contain this app's origin. The
 * check is server-side from the Referer of the player request, so one entry
 * covers every host portal that embeds us.
 */

import { useEffect, useState } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import {
  attachLearnerToken,
  attachSourceUser,
  getLaunch,
} from "~/.server/lti/store";
import {
  mintPlayerUrl,
  provisionAndEnrol,
  sourcePortal,
} from "~/.server/lti/portal";
import {
  MONITOR_IFRAME,
  enabled as smowlEnabled,
  monitoringUrl,
  registrationUrl,
  smowlConfig,
} from "~/.server/lti/smowl";

/**
 * How much explanatory chrome the player page carries.
 *
 * These banners were debugging aids, and they read like debugging aids. In
 * front of a customer the framing advisory and the shared-learner notice look
 * like unfinished software rather than the honest disclosures they are, so
 * they are off unless asked for.
 *
 *   off      nothing but the course (and the proctor panel, which is UI)
 *   minimal  completion status only -- the evidence that passback worked
 *   all      every banner, as during development
 *
 * NOTE the trade in "off" and "minimal": the shared-learner notice exists so
 * a demo is never mistaken for real per-learner provisioning. Hiding it is
 * fine while you are the one presenting and you know every launch shares one
 * account. It would not be fine if someone else were driving.
 */
type BannerLevel = "off" | "minimal" | "all";

function bannerLevel(): BannerLevel {
  const v = (process.env.LTI_PLAYER_BANNERS ?? "minimal").toLowerCase();
  return v === "off" || v === "all" ? v : "minimal";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const lid = new URL(request.url).searchParams.get("lid");
  const launch = lid ? getLaunch(lid) : null;

  if (!launch) {
    throw new Response(
      "This launch has expired. Return to the course in your LMS and launch it again.",
      { status: 410 }
    );
  }

  const cfg = sourcePortal();

  try {
    const learner = await provisionAndEnrol(cfg, {
      iss: launch.identity.iss,
      sub: launch.identity.sub,
      firstName: launch.identity.firstName,
      lastName: launch.identity.lastName,
      email: launch.identity.email,
      courseId: launch.sourceCourseId,
    });

    // Record the source-portal user id so the completion webhook can match
    // this learner back to this launch. Without it the score has nowhere to go.
    if (learner.userId) attachSourceUser(launch.launchId, learner.userId);

    // Kept so /lti/progress can poll the source portal without signing in
    // again on every tick.
    attachLearnerToken(launch.launchId, learner.token);

    const player = await mintPlayerUrl(cfg, learner.token, launch.sourceCourseId);

    /**
     * Proctoring, when configured. Signed here so SMOWL_JWT_SECRET never
     * reaches the browser — the page only ever receives finished URLs.
     */
    const smowl = smowlConfig();
    let proctor: {
      monitorUrl: string;
      registerUrl: string;
      frame: typeof MONITOR_IFRAME;
    } | null = null;
    if (smowlEnabled(smowl)) {
      /**
       * WHOM SMOWL PROCTORS.
       *
       * "launch" (default): the real person on the host portal, identified by
       * the LTI subject from a signature-verified id_token. Every bharrigan
       * learner becomes a distinct SMOWL user with their own face
       * registration and their own evidence trail.
       *
       * "source": the account on the content portal. In shared-learner mode
       * that is ONE account for everybody, so every learner would share a
       * single face registration -- which is not proctoring, it is a prop.
       *
       * This is the setting that decouples proctoring identity from the
       * shared-learner limitation: Absorb can play the course as one account
       * while SMOWL still watches, and names, the actual person.
       */
      const smowlIdentity = (process.env.SMOWL_IDENTITY ?? "launch").toLowerCase();
      const who = {
        userId:
          smowlIdentity === "source"
            ? (learner.userId ?? launch.ltiSub)
            : deterministicUsername(launch.platformId, launch.ltiSub),
        name:
          `${launch.identity.firstName} ${launch.identity.lastName}`.trim() ||
          "Learner",
        email: launch.identity.email ?? "",
      };
      const activity = {
        activityId: launch.sourceCourseId,
        containerId: launch.platformId,
        // Where SMOWL returns the learner after face registration.
        activityUrl: `${new URL(request.url).origin}/lti/play?lid=${launch.launchId}`,
      };
      proctor = {
        monitorUrl: monitoringUrl(smowl, who, activity, 1),
        registerUrl: registrationUrl(smowl, who, activity),
        frame: MONITOR_IFRAME,
      };
    }

    return json({
      ok: true as const,
      playerUrl: player.playerUrl,
      framable: player.framable,
      courseTitle: launch.courseTitle,
      // "shared" means every launch is playing as one account on the source
      // portal. Surfaced so a demo is never mistaken for real provisioning.
      shared: learner.mode === "shared",
      lid: launch.launchId,
      hasLineItem: Boolean(launch.ags?.lineitem),
      proctor,
      banners: bannerLevel(),
      error: null as string | null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[lti/play] launch failed:", message);
    return json({
      ok: false as const,
      playerUrl: null,
      framable: false,
      courseTitle: launch.courseTitle,
      shared: false,
      lid: null as string | null,
      hasLineItem: false,
      proctor: null as {
        monitorUrl: string;
        registerUrl: string;
        frame: typeof MONITOR_IFRAME;
      } | null,
      banners: bannerLevel(),
      error: message,
    });
  }
};

export default function LtiPlay() {
  const data = useLoaderData<typeof loader>();
  // "all" is development chrome; "minimal" keeps only the completion line.
  const showAllBanners = data.banners === "all";
  const showStatusBanners = data.banners !== "off";
  const [frameBlocked, setFrameBlocked] = useState(false);
  const [completion, setCompletion] = useState<
    "watching" | "complete" | "reported" | "nowhere"
  >("watching");
  const [reported, setReported] = useState<string | null>(null);

  /**
   * Proctoring gate.
   *
   * SMOWL's monitoring iframe posts `monitoringstatusOK` once every check has
   * passed, and `monitoringstatusNOTOK` if something is later disabled — a
   * revoked camera permission, say. The course stays hidden until OK arrives,
   * and is pulled if NOTOK does.
   *
   * `data.proctor` is null when SMOWL is not configured, and then this never
   * gates anything: no configuration, no change in behaviour.
   */
  const proctored = Boolean(data.ok && data.proctor);
  const [monitoring, setMonitoring] = useState<"waiting" | "ok" | "blocked">(
    "waiting"
  );

  useEffect(() => {
    if (!proctored) return;
    const onMessage = (e: MessageEvent) => {
      const payload =
        typeof e.data === "string"
          ? e.data
          : (e.data as { message?: string } | null)?.message;
      if (payload === "monitoringstatusOK") setMonitoring("ok");
      if (payload === "monitoringstatusNOTOK") setMonitoring("blocked");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [proctored]);

  /**
   * Ask our own server whether the source portal has recorded a completion,
   * and let it post the AGS score the moment it has.
   *
   * LTI tells a tool how to REPORT a completion, not how to notice one, and
   * this tool cannot see inside the player's cross-origin frame. Polling the
   * learner's own enrolment record is the cheapest way to notice, and it
   * reports while they are still on screen.
   *
   * Stops on `stop` (posted, already posted, or the launch is gone) so a
   * finished course does not poll forever.
   */
  useEffect(() => {
    if (!data.ok || !data.lid) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const r = await fetch(
          `/lti/progress?lid=${encodeURIComponent(data.lid as string)}`
        );
        const body = await r.json();
        if (cancelled) return;

        if (body.complete) {
          if (body.posted || body.already) {
            setCompletion("reported");
            if (typeof body.score === "number") {
              setReported(
                `${body.score}/100` +
                  (body.scoreSource ? ` (${body.scoreSource})` : "")
              );
            }
          } else {
            setCompletion(data.hasLineItem ? "complete" : "nowhere");
          }
        }
        if (body.stop) {
          clearInterval(timer);
        }
      } catch {
        // A failed poll is not interesting: the learner is still in the course.
      }
    };

    const timer = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [data.ok, data.lid, data.hasLineItem]);

  /**
   * Chrome fires `load` on an X-Frame-Options refusal page, so "did it load"
   * cannot detect a block. A watchdog is the only signal available: if the
   * frame has not reported anything useful in time, offer the new window.
   * The same 8-9s window the embed widget uses.
   */
  useEffect(() => {
    if (!data.ok || !data.framable) return;
    const t = setTimeout(() => setFrameBlocked(true), 9000);
    return () => clearTimeout(t);
  }, [data.ok, data.framable]);

  if (!data.ok) {
    return (
      <div style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 680 }}>
        <h1 style={{ fontSize: "1.15rem" }}>This course could not be opened</h1>
        <p style={{ color: "#555" }}>
          The launch was valid, but setting the learner up on the content portal
          failed. The detail below is for whoever configured this integration.
        </p>
        <pre
          style={{
            background: "#f6f6f6",
            padding: "1rem",
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            fontSize: ".85rem",
            lineHeight: 1.5,
          }}
        >
          {data.error}
        </pre>
        <p style={{ color: "#777", fontSize: ".85rem" }}>
          A 401 is the source portal rejecting a username and password. A 403 is
          a key or permission problem. The service log carries the full detail
          under the <code>[lti/portal]</code> prefix.
        </p>
      </div>
    );
  }

  /**
   * Always points at /lti/play/open, never at the already-minted playerUrl:
   * that token is single use and the inline frame has probably spent it.
   */
  const openHref = data.lid
    ? `/lti/play/open?lid=${encodeURIComponent(data.lid)}`
    : "#";

  const openInWindow = (
    <p style={{ marginTop: "1rem" }}>
      <a
        href={openHref}
        target="_blank"
        rel="noreferrer"
        style={{
          display: "inline-block",
          padding: ".6rem 1.1rem",
          background: "#1d4ed8",
          color: "#fff",
          borderRadius: 6,
          textDecoration: "none",
        }}
      >
        Open the course in a new window
      </a>
    </p>
  );

  if (!data.framable) {
    return (
      <div style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 680 }}>
        <h1 style={{ fontSize: "1.15rem" }}>
          {data.courseTitle ?? "Your course"}
        </h1>
        <p style={{ color: "#555" }}>
          This course opens in its own window rather than inline.
        </p>
        {openInWindow}
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", margin: 0, display: "flex", flexDirection: "column" }}>
      {showAllBanners ? (
      <div
        style={{
          fontFamily: "system-ui",
          fontSize: ".8rem",
          padding: ".45rem .75rem",
          background: "#eef2ff",
          borderBottom: "1px solid #c7d2fe",
          color: "#312e81",
          display: "flex",
          gap: ".75rem",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
        }}
      >
        <span>
          If your progress does not save, open the course in its own window —
          embedded players cannot always record completion.
        </span>
        <a
          href={openHref}
          target="_blank"
          rel="noreferrer"
          style={{
            background: "#4338ca",
            color: "#fff",
            padding: ".3rem .7rem",
            borderRadius: 5,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Open in a new window
        </a>
      </div>
      ) : null}
      {showStatusBanners && completion === "reported" ? (
        <div
          style={{
            fontFamily: "system-ui",
            fontSize: ".8rem",
            padding: ".4rem .75rem",
            background: "#e8f5e9",
            borderBottom: "1px solid #a5d6a7",
            color: "#1b5e20",
          }}
        >
          Completion reported back to this portal
          {reported ? <> — <strong>{reported}</strong></> : null}.
        </div>
      ) : null}
      {showStatusBanners && completion === "nowhere" ? (
        <div
          style={{
            fontFamily: "system-ui",
            fontSize: ".8rem",
            padding: ".4rem .75rem",
            background: "#fdecea",
            borderBottom: "1px solid #f5c6cb",
            color: "#7f231c",
          }}
        >
          Course complete on the content portal, but this link has no grade
          column, so there is nowhere to report it.
        </div>
      ) : null}
      {showAllBanners && data.shared ? (
        <div
          style={{
            fontFamily: "system-ui",
            fontSize: ".8rem",
            padding: ".4rem .75rem",
            background: "#fff8e1",
            borderBottom: "1px solid #ffe082",
            color: "#7a5900",
          }}
        >
          Shared-learner mode: everyone plays as one account on the content
          portal, so progress is shared. Demo only.
        </div>
      ) : null}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {data.proctor ? (
          <div
            style={{
              width: data.proctor.frame.width,
              borderRight: "1px solid #e3e3e3",
              padding: ".5rem",
              fontFamily: "system-ui",
              fontSize: ".75rem",
              background: "#fafafa",
              flexShrink: 0,
            }}
          >
            <iframe
              title="Proctoring"
              src={data.proctor.monitorUrl}
              allow={data.proctor.frame.allow}
              sandbox={data.proctor.frame.sandbox}
              width={data.proctor.frame.width}
              height={data.proctor.frame.height}
              frameBorder={0}
              scrolling="no"
              allowFullScreen
            />
            <p style={{ color: "#666", marginTop: ".5rem" }}>
              {monitoring === "ok"
                ? "Monitoring active."
                : monitoring === "blocked"
                  ? "Monitoring stopped — the course has been hidden."
                  : "Waiting for camera checks to pass..."}
            </p>
            <p style={{ marginTop: ".5rem" }}>
              <a href={data.proctor.registerUrl} target="_blank" rel="noreferrer">
                Not registered yet? Register your face
              </a>
            </p>
          </div>
        ) : null}

        {/* The course itself. Mounted only once monitoring is confirmed, so a
            learner cannot see the content before checks pass. */}
        {!proctored || monitoring === "ok" ? (
          <iframe
            title={data.courseTitle ?? "Course player"}
            src={data.playerUrl ?? undefined}
            allow="fullscreen; autoplay; camera; microphone"
            allowFullScreen
            style={{ flex: 1, width: "100%", border: 0 }}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "system-ui",
              color: "#555",
              padding: "2rem",
              textAlign: "center",
            }}
          >
            <div>
              <p style={{ fontWeight: 600 }}>
                {monitoring === "blocked"
                  ? "Monitoring stopped"
                  : "Setting up proctoring"}
              </p>
              <p style={{ fontSize: ".9rem" }}>
                {monitoring === "blocked"
                  ? "Camera or microphone access was lost. Restore it to continue."
                  : "The course will appear once the camera and identity checks pass."}
              </p>
            </div>
          </div>
        )}
      </div>
      {showAllBanners && frameBlocked ? (
        <div
          style={{
            fontFamily: "system-ui",
            padding: ".75rem 1rem",
            borderTop: "1px solid #e3e3e3",
            fontSize: ".9rem",
          }}
        >
          Still loading? Your browser may be blocking the embedded player.
          {openInWindow}
        </div>
      ) : null}
    </div>
  );
}
