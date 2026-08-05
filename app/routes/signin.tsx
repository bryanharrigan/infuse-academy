/**
 * app/routes/signin.tsx
 *
 * Sign-in entrypoint with two paths:
 *
 * 1. DIRECT (default): username/password form → server action calls
 *    Absorb's /api/rest/v2/authentication endpoint from the Lambda,
 *    receives a tenant JWT, stores it in the infuseJwtCookie, and
 *    redirects to /. Bypasses Absorb's OAuth /ExternalLogin/Consent
 *    page entirely — the page that has been rejecting learner creds
 *    for accounts that don't satisfy the OAuth client's user policy.
 *
 * 2. OAUTH (fallback): "Try Absorb SSO instead" link at the bottom
 *    of the form triggers the original OAuth flow at /signin?oauth=1
 *    which redirects to Absorb's /oauth/authorize. Useful if you
 *    actually want SSO and your account satisfies whatever OAuth
 *    restrictions the tenant has configured.
 */

import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData } from "@remix-run/react";
import { authenticate } from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import {
  buildAuthorizeUrl,
  newState,
  rememberState,
} from "~/.server/infuse-oauth";

/**
 * Default path is Absorb SSO: redirect to Absorb's hosted OAuth login.
 *
 * `?password=1` renders a direct username/password form instead. Kept as
 * an escape hatch for when Absorb's hosted login is unavailable — it
 * authenticates against the same Absorb API and yields the same tenant
 * JWT, so the rest of the app behaves identically either way.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("password") === "1") {
    return json({ mode: "password" as const });
  }

  const state = newState();
  return redirect(buildAuthorizeUrl(state), {
    headers: {
      "Set-Cookie": await rememberState(request.headers.get("Cookie"), state),
    },
  });
};

// ─── Action: direct credential auth against Absorb API ─────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!username || !password) {
    return json(
      { error: "Enter both your username and password." },
      { status: 400 }
    );
  }

  try {
    const { token } = await authenticate(username, password);
    return redirect("/", {
      headers: { "Set-Cookie": await infuseJwtCookie.serialize(token) },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // 401 keeps CF from intercepting (only 5xx get replaced with CF's
    // own error page). See callback route for the same reasoning.
    return json({ error: detail }, { status: 401 });
  }
};

// ─── Form UI ───────────────────────────────────────────────────────

export default function SignIn() {
  const actionData = useActionData<typeof action>();
  const formRef = useRef<HTMLFormElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const [showError, setShowError] = useState(false);
  // Local submitting state (not useNavigation) — we're using a native
  // <form> POST that triggers a full page navigation, so React state
  // is thrown away as soon as submit happens. This is just to grey
  // out the button between click and navigation for user feedback.
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (actionData?.error) {
      setShowError(true);
      setSubmitting(false);
      usernameRef.current?.focus();
    }
  }, [actionData]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(1200px 800px at 20% 10%, #2a1f6e 0%, #0a0a1a 60%, #050508 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        color: "#fff",
        fontFamily:
          "'Inter', 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background:
            "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 20,
          padding: "40px 32px 32px",
          boxShadow: "0 30px 60px rgba(0,0,0,0.5)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background:
                "linear-gradient(135deg, #6c63ff 0%, #ff6584 100%)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 800,
              fontSize: 26,
              color: "#fff",
              marginBottom: 16,
              boxShadow: "0 10px 30px rgba(108,99,255,0.35)",
            }}
          >
            iX
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: -0.3,
            }}
          >
            Sign in to Infuse
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 14,
              opacity: 0.65,
            }}
          >
            Use your Absorb learner credentials
          </p>
        </div>

        {showError && actionData?.error && (
          <div
            style={{
              background: "rgba(220, 38, 38, 0.15)",
              border: "1px solid rgba(220, 38, 38, 0.35)",
              color: "#ffb4b4",
              borderRadius: 10,
              padding: "10px 14px",
              marginBottom: 16,
              fontSize: 13,
              lineHeight: 1.4,
            }}
          >
            {actionData.error}
          </div>
        )}

        {/* Posts back to ?password=1 so the loader revalidation that
            follows the action keeps rendering this form instead of
            redirecting into OAuth and losing the error message. */}
        <form
          method="post"
          action="/signin?password=1"
          ref={formRef}
          onSubmit={() => setSubmitting(true)}
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 500 }}>
              Username
            </span>
            <input
              ref={usernameRef}
              name="username"
              type="text"
              autoComplete="username"
              required
              disabled={submitting}
              style={inputStyle}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 500 }}>
              Password
            </span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={submitting}
              style={inputStyle}
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            style={{
              marginTop: 6,
              padding: "12px 16px",
              borderRadius: 10,
              border: "none",
              background: submitting
                ? "rgba(108,99,255,0.4)"
                : "linear-gradient(135deg, #6c63ff 0%, #ff6584 100%)",
              color: "#fff",
              fontSize: 15,
              fontWeight: 600,
              cursor: submitting ? "wait" : "pointer",
              transition: "transform 0.1s ease",
            }}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {/* SSO fallback link removed — Absorb's SSO 5.128 update
            broke the OAuth learner login path for this tenant. */}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(0,0,0,0.35)",
  color: "#fff",
  fontSize: 15,
  outline: "none",
  transition: "border-color 0.15s ease",
};
