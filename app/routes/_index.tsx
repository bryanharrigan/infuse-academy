/**
 * app/routes/_index.tsx
 *
 * Home page. Root loader handles auth so by the time this renders,
 * the user is logged in and we can show a welcome + nav.
 */

import { Link, useRouteLoaderData } from "@remix-run/react";
import { Box, Button, Typography, Paper, Stack } from "@mui/material";
import {
  School as SchoolIcon,
  CollectionsBookmark as CollectionsBookmarkIcon,
} from "@mui/icons-material";
import { useAppStateContext } from "~/context/app-state.context";

type RootData = {
  userProfile: { firstName: string; lastName: string };
  avatarUrl: string;
};

export default function Index() {
  const data = useRouteLoaderData("root") as RootData | null;
  const firstName = data?.userProfile?.firstName ?? "";
  const { themeVariant } = useAppStateContext();
  // IA layout also powers the RadNet variant.
  const isIA = themeVariant !== "default";

  // ─── Infuse Academy variant ──────────────────────────────────────────
  if (isIA) {
    return (
      <>
        <section className="ia-hero ia-animate" style={{ marginTop: 72 }}>
          <div className="ia-hero__inner">
            <div>
              <h1 className="ia-hero__title">
                Welcome{firstName ? "," : "!"}{" "}
                {firstName ? (
                  <span className="ia-text-gradient">{firstName}</span>
                ) : null}
              </h1>
              <p className="ia-hero__sub">
                Your Absorb Infuse learning portal — track progress, earn
                achievements, and keep your streak alive.
              </p>
            </div>
          </div>
        </section>

        <section className="ia-section">
          <div className="ia-container">
            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={3}
              className="ia-animate"
            >
              <div
                className="ia-landing-card"
                style={{ flex: 1 }}
              >
                <div className="ia-landing-card__icon">
                  <SchoolIcon />
                </div>
                <Typography
                  variant="h5"
                  sx={{ fontFamily: "'Space Grotesk', sans-serif" }}
                >
                  My Courses
                </Typography>
                <Typography variant="body2" sx={{ color: "var(--ia-text-muted)" }}>
                  Continue or review courses you&apos;re enrolled in.
                </Typography>
                <Button
                  component={Link}
                  to="/my-courses"
                  variant="contained"
                  color="primary"
                  sx={{ mt: 2, alignSelf: "flex-start" }}
                >
                  View My Courses →
                </Button>
              </div>

              <div
                className="ia-landing-card"
                style={{
                  flex: 1,
                }}
              >
                <div
                  className="ia-landing-card__icon"
                  style={{ background: "var(--ia-gradient-cool)" }}
                >
                  <CollectionsBookmarkIcon />
                </div>
                <Typography
                  variant="h5"
                  sx={{ fontFamily: "'Space Grotesk', sans-serif" }}
                >
                  Catalog
                </Typography>
                <Typography variant="body2" sx={{ color: "var(--ia-text-muted)" }}>
                  Browse and enroll in available courses.
                </Typography>
                <Button
                  component={Link}
                  to="/catalog"
                  variant="outlined"
                  sx={{ mt: 2, alignSelf: "flex-start" }}
                >
                  Browse Catalog →
                </Button>
              </div>
            </Stack>
          </div>
        </section>
      </>
    );
  }

  // ─── Default variant (unchanged) ─────────────────────────────────────
  return (
    <Box className="p-12 mt-[75px]" sx={{ maxWidth: 900, mx: "auto" }}>
      <Typography variant="h3" gutterBottom>
        Welcome{firstName ? `, ${firstName}` : ""}.
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        This is your Absorb Infuse learning portal.
      </Typography>

      <Stack direction={{ xs: "column", md: "row" }} spacing={3}>
        <Paper elevation={2} sx={{ p: 4, flex: 1 }}>
          <SchoolIcon sx={{ fontSize: 40, mb: 1 }} color="primary" />
          <Typography variant="h6" gutterBottom>
            My Courses
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Continue or review courses you&apos;re enrolled in.
          </Typography>
          <Button
            component={Link}
            to="/my-courses"
            variant="contained"
            fullWidth
          >
            View My Courses
          </Button>
        </Paper>

        <Paper elevation={2} sx={{ p: 4, flex: 1 }}>
          <CollectionsBookmarkIcon sx={{ fontSize: 40, mb: 1 }} color="primary" />
          <Typography variant="h6" gutterBottom>
            Catalog
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Browse and enroll in available courses.
          </Typography>
          <Button component={Link} to="/catalog" variant="contained" fullWidth>
            Browse Catalog
          </Button>
        </Paper>
      </Stack>
    </Box>
  );
}
