import { createTheme } from "@mui/material/styles";

/**
 * RadNet MUI theme — light mode matching radnet.com.
 *
 * Palette pulled directly from radnet.com's `--color-radnet-*` CSS variables:
 *   Primary (bright red):  #c82030
 *   Corporate red:         #851f1e
 *   Sky blue:              #0e78be
 *   Navy:                  #233666
 *   Body text:             #212529  (radnet.com's body color)
 *   Muted text:            #706f70  (radnet-dark-gray)
 *
 * Uses the same structural Card/Button/Dialog overrides as the Infuse Academy
 * theme, but with a light palette and Open Sans typography so the styled
 * layout from `body.theme-ia` can still function in a white-background UI.
 */

const RN = {
  bg: "#ffffff",
  bgAlt: "#f7f8fa",
  surface: "#ffffff",
  border: "rgba(0,0,0,0.08)",
  borderStrong: "rgba(0,0,0,0.12)",

  red: "#c82030",
  redDark: "#851f1e",
  blue: "#0e78be",
  navy: "#233666",
  green: "#2d9c5d",
  amber: "#cc8400",

  text: "#212529",
  textMuted: "#706f70",
  textDim: "#9a9a9a",
} as const;

const radnetTheme = createTheme({
  palette: {
    mode: "light",
    primary: { main: RN.red, dark: RN.redDark, contrastText: "#ffffff" },
    secondary: { main: RN.blue, dark: RN.navy, contrastText: "#ffffff" },
    success: { main: RN.green },
    warning: { main: RN.amber },
    error: { main: RN.red },
    background: { default: RN.bg, paper: RN.surface },
    text: { primary: RN.text, secondary: RN.textMuted, disabled: RN.textDim },
    divider: RN.border,
  },
  typography: {
    fontFamily:
      "'Open Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    h1: { fontFamily: "'Open Sans', 'Inter', sans-serif", fontWeight: 700, letterSpacing: "-0.01em" },
    h2: { fontFamily: "'Open Sans', 'Inter', sans-serif", fontWeight: 700, letterSpacing: "-0.01em" },
    h3: { fontFamily: "'Open Sans', 'Inter', sans-serif", fontWeight: 700 },
    h4: { fontFamily: "'Open Sans', 'Inter', sans-serif", fontWeight: 600 },
    h5: { fontFamily: "'Open Sans', 'Inter', sans-serif", fontWeight: 600 },
    h6: { fontFamily: "'Open Sans', 'Inter', sans-serif", fontWeight: 600 },
    button: { fontWeight: 600, textTransform: "none", letterSpacing: 0 },
  },
  shape: { borderRadius: 12 },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: RN.surface,
          border: `1px solid ${RN.border}`,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundColor: RN.surface,
          border: `1px solid ${RN.border}`,
          borderRadius: 20,
          transition:
            "transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.4s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.4s",
          "&:hover": {
            transform: "translateY(-4px)",
            boxShadow: "0 16px 40px rgba(0,0,0,0.1)",
            borderColor: "rgba(200,32,48,0.25)",
          },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 100, paddingInline: 20, paddingBlock: 10 },
        containedPrimary: {
          background: `linear-gradient(135deg, ${RN.red} 0%, ${RN.redDark} 100%)`,
          boxShadow: "0 6px 18px rgba(200,32,48,0.3)",
          "&:hover": {
            background: `linear-gradient(135deg, ${RN.red} 0%, ${RN.redDark} 100%)`,
            filter: "brightness(1.05)",
            boxShadow: "0 8px 24px rgba(200,32,48,0.4)",
          },
        },
        containedSecondary: {
          background: `linear-gradient(135deg, ${RN.blue} 0%, ${RN.navy} 100%)`,
          boxShadow: "0 6px 18px rgba(35,54,102,0.25)",
          "&:hover": {
            background: `linear-gradient(135deg, ${RN.blue} 0%, ${RN.navy} 100%)`,
            filter: "brightness(1.05)",
          },
        },
        outlined: {
          borderColor: RN.borderStrong,
          color: RN.text,
          "&:hover": {
            borderColor: RN.red,
            backgroundColor: "rgba(200,32,48,0.06)",
          },
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: "rgba(255,255,255,0.85)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          borderBottom: `1px solid ${RN.border}`,
          color: RN.text,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: RN.surface,
          backgroundImage: "none",
          border: `1px solid ${RN.border}`,
          borderRadius: 20,
          color: RN.text,
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { borderRadius: 8, height: 8, backgroundColor: "rgba(0,0,0,0.08)" },
        bar: { background: `linear-gradient(135deg, ${RN.red} 0%, ${RN.redDark} 100%)` },
      },
    },
    MuiCircularProgress: {
      styleOverrides: { root: { color: RN.red } },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          "& .MuiOutlinedInput-root": {
            backgroundColor: RN.bgAlt,
            "& fieldset": { borderColor: RN.border },
            "&:hover fieldset": { borderColor: RN.red },
            "&.Mui-focused fieldset": { borderColor: RN.red },
          },
        },
      },
    },
    MuiSelect: {
      styleOverrides: {
        outlined: { color: RN.text },
      },
    },
  },
});

export default radnetTheme;
export { RN };
