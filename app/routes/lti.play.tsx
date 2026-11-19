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
  attachSourceUser,
  getLaunch,
} from "~/.server/lti/store";
import {
  mintPlayerUrl,
  provisionAndEnrol,
  sourcePortal,
} from "~/.server/lti/portal";

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

    const player = await mintPlayerUrl(cfg, learner.token, launch.sourceCourseId);

    return json({
      ok: true as const,
      playerUrl: player.playerUrl,
      framable: player.framable,
      courseTitle: launch.courseTitle,
      // "shared" means every launch is playing as one account on the source
      // portal. Surfaced so a demo is never mistaken for real provisioning.
      shared: learner.mode === "shared",
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
      error: message,
    });
  }
};

export default function LtiPlay() {
  const data = useLoaderData<typeof loader>();
  const [frameBlocked, setFrameBlocked] = useState(false);

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
          }}
        >
          {data.error}
        </pre>
      </div>
    );
  }

  const openInWindow = (
    <p style={{ marginTop: "1rem" }}>
      <a
        href={data.playerUrl ?? "#"}
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
      {data.shared ? (
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
      <iframe
        title={data.courseTitle ?? "Course player"}
        src={data.playerUrl ?? undefined}
        allow="fullscreen; autoplay; camera; microphone"
        allowFullScreen
        style={{ flex: 1, width: "100%", border: 0 }}
      />
      {frameBlocked ? (
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
