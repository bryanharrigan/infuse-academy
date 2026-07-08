import { createTheme } from "@mui/material/styles";

/**
 * CrossFit MUI theme.
 *
 * Aesthetic recreated from crossfit.com/education/explore-courses:
 *   - Near-black background (#0a0a0a) with white text
 *   - CrossFit red accent (#B0110D)
 *   - Bebas Neue / Roboto Condensed uppercase display type
 *   - Sharp corners (0 border-radius) everywhere
 *   - Heavy 900-weight for headlines, 700 for buttons
 *
 * The MUI theme handles button + surface chrome; the standalone
 * app/styles/crossfit.css carries the page layout, cards, credential
 * band, and course grid.
 */

const CF = {
  bg: "#0a0a0a",
  bgAlt: "#141414",
  surface: "#1a1a1a",
  surfaceHi: "#232323",
  border: "rgba(255,255,255,0.12)",
  borderHi: "rgba(255,255,255,0.25)",

  red: "#B0110D",
  redHi: "#e01515",
  redDark: "#7a0b09",

  text: "#ffffff",
  textMuted: "rgba(255,255,255,0.72)",
  textDim: "rgba(255,255,255,0.5)",
} as const;

const crossfitTheme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: CF.red, dark: CF.redDark, contrastText: "#ffffff" },
    secondary: { main: "#ffffff", contrastText: CF.bg },
    error: { main: CF.red },
    background: { default: CF.bg, paper: CF.surface },
    text: { primary: CF.text, secondary: CF.textMuted, disabled: CF.textDim },
    divider: CF.border,
  },
  typography: {
    fontFamily:
      "'Roboto Condensed', 'Bebas Neue', 'Barlow Condensed', 'Impact', -apple-system, sans-serif",
    h1: {
      fontFamily: "'Bebas Neue', 'Roboto Condensed', sans-serif",
      fontWeight: 900,
      textTransform: "uppercase",
      letterSpacing: "0.01em",
    },
    h2: {
      fontFamily: "'Bebas Neue', 'Roboto Condensed', sans-serif",
      fontWeight: 900,
      textTransform: "uppercase",
      letterSpacing: "0.01em",
    },
    h3: {
      fontFamily: "'Bebas Neue', 'Roboto Condensed', sans-serif",
      fontWeight: 900,
      textTransform: "uppercase",
    },
    h4: { fontWeight: 900, textTransform: "uppercase" },
    h5: { fontWeight: 800, textTransform: "uppercase" },
    h6: { fontWeight: 800, textTransform: "uppercase" },
    button: {
      fontWeight: 800,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
    },
  },
  shape: { borderRadius: 0 },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: CF.surface,
          border: `1px solid ${CF.border}`,
          borderRadius: 0,
          color: CF.text,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundColor: CF.surface,
          border: `1px solid ${CF.border}`,
          borderRadius: 0,
          transition:
            "transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease",
          "&:hover": {
            borderColor: CF.red,
            boxShadow: `0 6px 24px rgba(176,17,13,0.35)`,
          },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 0,
          paddingInline: 20,
          paddingBlock: 12,
          fontWeight: 800,
        },
        containedPrimary: {
          backgroundColor: CF.red,
          color: "#ffffff",
          boxShadow: "none",
          "&:hover": {
            backgroundColor: CF.redHi,
            boxShadow: "none",
          },
        },
        outlined: {
          borderColor: CF.borderHi,
          color: CF.text,
          "&:hover": {
            borderColor: CF.red,
            backgroundColor: "rgba(176,17,13,0.08)",
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: CF.bg,
          border: `1px solid ${CF.border}`,
          borderRadius: 0,
          color: CF.text,
        },
      },
    },
    MuiCircularProgress: {
      styleOverrides: { root: { color: CF.red } },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: {
          backgroundColor: "rgba(255,255,255,0.08)",
          height: 6,
          borderRadius: 0,
        },
        bar: {
          backgroundColor: CF.red,
          borderRadius: 0,
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: "#000",
          border: `1px solid ${CF.borderHi}`,
          borderRadius: 0,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        },
      },
    },
  },
});

export default crossfitTheme;
