import * as React from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLocation } from "@remix-run/react";
import "./tailwind.css";
import "./styles/infuse-academy.css";
import { withEmotionCache } from "@emotion/react";
import {
  ThemeProvider,
  unstable_useEnhancedEffect as useEnhancedEffect,
} from "@mui/material";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import ClientStyleContext from "./context/client-style.context";
import defaultTheme from "./mui/theme";
import infuseAcademyTheme from "./mui/theme-infuse-academy";
import radnetTheme from "./mui/theme-radnet";
import { Header } from "./components/header/header.component";
import { RadnetFooter } from "./components/footer/radnet-footer.component";
import {
  AppStateProvider,
  useAppStateContext,
} from "./context/app-state.context";
import { getUserProfile, getUserAvatar, type UserProfileResponse } from "./.server/infuse-api";
import { infuseJwtCookie } from "./constants/infuse-cookie.server";

interface DocumentProps { children: React.ReactNode; title?: string; }

const Document = withEmotionCache(({ children, title }: DocumentProps, emotionCache) => {
  const clientStyleData = React.useContext(ClientStyleContext);
  useEnhancedEffect(() => {
    emotionCache.sheet.container = document.head;
    const tags = emotionCache.sheet.tags;
    emotionCache.sheet.flush();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tags.forEach((tag) => { (emotionCache.sheet as any)._insertTag(tag); });
    clientStyleData.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="theme-color" content="#0a0a0f" />
        {title ? <title>{title}</title> : null}
        <Meta />
        <Links />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/*
          Load both the default Roboto and the IA theme's display fonts so we
          don't need to re-fetch on toggle. Fonts only render when the
          associated font-family rules are active.
        */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@400;500;600;700&display=swap"
        />
        <meta name="emotion-insertion-point" content="emotion-insertion-point" />
      </head>
      <body>
        {/*
          SVG gradient definition for the IA progress-ring component. Only
          renders when the IA theme is active (defined server-side so it's
          present in the DOM when CSS references it).
        */}
        {/*
          SVG gradient used by IA progress rings. Colors reference CSS vars
          so they automatically flip with the active theme — RadNet redefines
          --ia-accent-1/2 under `body.theme-radnet`, so these stops become
          RadNet red/blue. Falls back to the IA purple/pink defaults otherwise.
        */}
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
          <defs>
            <linearGradient id="ia-ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="var(--ia-accent-1, #6c63ff)" />
              <stop offset="100%" stopColor="var(--ia-accent-2, #ff6584)" />
            </linearGradient>
          </defs>
        </svg>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cookieHeader = request.headers.get("Cookie");
  const token = await infuseJwtCookie.parse(cookieHeader);
  const url = new URL(request.url);
  const path = url.pathname;

  if (!token && path !== "/signin") return redirect("/signin");
  if (token && path === "/signin") return redirect("/");
  if (!token) return json(null);

  try {
    const userProfile: UserProfileResponse = await getUserProfile(token);
    const avatarUrl: string = await getUserAvatar(token);
    return json({ userProfile, avatarUrl });
  } catch {
    return redirect("/signout");
  }
};

/**
 * Switches MUI's ThemeProvider based on the active theme variant in
 * AppStateContext. Lives inside the provider so it can read the context.
 */
const ThemedShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { themeVariant } = useAppStateContext();
  const activeTheme =
    themeVariant === "radnet"
      ? radnetTheme
      : themeVariant === "infuse-academy"
      ? infuseAcademyTheme
      : defaultTheme;
  return <ThemeProvider theme={activeTheme}>{children}</ThemeProvider>;
};

export default function App() {
  const location = useLocation();
  const isNotLoginPage = location.pathname !== "/signin";
  return (
    <Document>
      <AppStateProvider>
        <ThemedShell>
          {isNotLoginPage && <Header />}
          <Outlet />
          {isNotLoginPage && <RadnetFooter />}
        </ThemedShell>
      </AppStateProvider>
    </Document>
  );
}
