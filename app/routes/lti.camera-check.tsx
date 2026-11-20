/**
 * app/routes/lti.camera-check.tsx  ->  GET /lti/camera-check
 *
 * Answers one question: can a page served from this origin get the camera
 * when Absorb is framing it?
 *
 * WHY IT MATTERS
 * --------------
 * Camera and microphone are delegated by Permissions Policy, and EVERY iframe
 * in the chain has to pass them down with allow="camera; microphone". Absorb's
 * lesson iframe is not ours, so whether proctoring can run inline is not
 * something we can reason our way to -- it has to be measured.
 *
 *   Works inline  -> an Object or SCORM lesson in "modal (iFrame)" mode can
 *                    proctor, and the whole design gets simpler.
 *   Blocked       -> the lesson must launch in a POPUP, which is a top-level
 *                    browsing context where permission is granted normally.
 *
 * It lives under /lti/ because root.tsx already exempts that prefix from the
 * auth guard and renders it on a bare shell. The name is a slight lie -- this
 * has nothing to do with LTI. It is temporary.
 *
 * DELETE THIS once the launch mode is settled.
 *
 * Nothing is recorded and no stream is kept: the track is stopped the instant
 * it is granted.
 */

import { useEffect, useState } from "react";

type Result = {
  outcome: "pending" | "granted" | "denied" | "blocked" | "unsupported";
  detail: string;
  framed: boolean;
  policyAllows: string;
  permissionState: string;
};

export default function CameraCheck() {
  const [r, setR] = useState<Result>({
    outcome: "pending",
    detail: "Asking for the camera...",
    framed: false,
    policyAllows: "unknown",
    permissionState: "unknown",
  });

  useEffect(() => {
    const framed = window.self !== window.top;

    // Chrome still exposes this, and it reports the POLICY decision rather
    // than the user's choice -- which is exactly the thing we are testing.
    let policyAllows = "not reported by this browser";
    try {
      const fp = (document as unknown as {
        featurePolicy?: { allowsFeature: (f: string) => boolean };
      }).featurePolicy;
      if (fp) policyAllows = fp.allowsFeature("camera") ? "yes" : "NO";
    } catch {
      /* ignore */
    }

    const run = async () => {
      let permissionState = "unknown";
      try {
        const p = await navigator.permissions?.query({
          name: "camera" as PermissionName,
        });
        if (p) permissionState = p.state;
      } catch {
        /* Firefox and Safari do not support querying camera */
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setR({
          outcome: "unsupported",
          detail: "navigator.mediaDevices.getUserMedia is not available here.",
          framed,
          policyAllows,
          permissionState,
        });
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        stream.getTracks().forEach((t) => t.stop());
        setR({
          outcome: "granted",
          detail: "Camera and microphone were granted. Proctoring can run here.",
          framed,
          policyAllows,
          permissionState,
        });
      } catch (err) {
        const e = err as { name?: string; message?: string };
        // The distinction that matters: a POLICY block is not the learner
        // clicking Block. Chrome reports both as NotAllowedError, so the
        // policy reading above is what separates them.
        const policyBlocked = policyAllows === "NO";
        setR({
          outcome: policyBlocked ? "blocked" : "denied",
          detail: policyBlocked
            ? "Permissions Policy blocked it. The framing page did not pass " +
              "camera down, so no prompt was ever shown. This lesson must " +
              "launch in a POPUP."
            : `${e.name ?? "Error"}: ${e.message ?? "no detail"}`,
          framed,
          policyAllows,
          permissionState,
        });
      }
    };
    void run();
  }, []);

  const colour =
    r.outcome === "granted"
      ? "#1b5e20"
      : r.outcome === "pending"
        ? "#555"
        : "#7f231c";

  return (
    <div style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 560 }}>
      <h1 style={{ fontSize: "1.1rem", margin: 0 }}>Camera check</h1>
      <p style={{ color: colour, fontWeight: 600, fontSize: "1.05rem" }}>
        {r.outcome === "granted"
          ? "GRANTED — inline proctoring will work"
          : r.outcome === "blocked"
            ? "BLOCKED BY POLICY — popup launch required"
            : r.outcome === "pending"
              ? "Checking..."
              : r.outcome.toUpperCase()}
      </p>
      <p style={{ fontSize: ".9rem" }}>{r.detail}</p>
      <table style={{ fontSize: ".8rem", borderCollapse: "collapse" }}>
        <tbody>
          {[
            ["In an iframe", r.framed ? "yes" : "no (top level)"],
            ["Policy allows camera", r.policyAllows],
            ["Permission state", r.permissionState],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={{ padding: ".2rem .75rem .2rem 0", color: "#555" }}>{k}</td>
              <td style={{ padding: ".2rem 0", fontWeight: 600 }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: ".75rem", color: "#777", marginTop: "1rem" }}>
        Nothing is recorded. The stream is stopped the moment it is granted.
      </p>
    </div>
  );
}
