/**
 * app/routes/_index.tsx
 *
 * Home (/) — every authenticated user lands on a Learning Hub. Which hub
 * they see depends on their selected theme variant:
 *
 *   experimental  → /learning-hub-experimental  (the new default)
 *   infuse-academy / radnet / default → /learning-hub  (IA-styled hub)
 *
 * Server-side: we redirect to the experimental hub eagerly, since that's
 * the new product default. Visitors who have explicitly chosen a different
 * theme have it persisted in localStorage; the brief client-side
 * useEffect below catches them on hydration and bounces to the IA hub
 * instead. This trades a small flash for a clean server redirect for
 * the majority of users.
 */

import { useEffect } from "react";
import {
  type LoaderFunctionArgs,
  redirect,
} from "@remix-run/node";
import { useNavigate } from "@remix-run/react";
import { useAppStateContext } from "~/context/app-state.context";

export const loader = async (_args: LoaderFunctionArgs) => {
  // Default route — bounce straight to the experimental Learning Hub.
  // Auth has already been enforced by the root loader.
  return redirect("/learning-hub-experimental");
};

export default function Index() {
  const { themeVariant } = useAppStateContext();
  const navigate = useNavigate();

  // If the user has a non-experimental theme persisted in localStorage,
  // they'll hydrate here briefly before this redirects them to /learning-hub.
  // (Most users land at /learning-hub-experimental via the loader redirect
  // and never see this component.)
  useEffect(() => {
    if (themeVariant === "crossfit") {
      navigate("/learning-hub-crossfit", { replace: true });
    } else if (
      themeVariant === "infuse-academy" ||
      themeVariant === "radnet" ||
      themeVariant === "default"
    ) {
      navigate("/learning-hub", { replace: true });
    } else if (themeVariant === "experimental") {
      navigate("/learning-hub-experimental", { replace: true });
    }
  }, [themeVariant, navigate]);

  // Fallback in case neither path matches — the loader's server-side
  // redirect should preempt this entirely.
  return null;
}
