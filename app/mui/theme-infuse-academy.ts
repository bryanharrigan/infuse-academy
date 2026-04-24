import { createTheme } from "@mui/material/styles";

/**
 * Infuse Academy MUI theme — "Bold Geometric Training".
 *
 * Palette, typography, radii and shadows are pulled from the WordPress theme's
 * theme.css (ia-* CSS variables). Dark mode, electric accents, generous radii,
 * and glow shadows.
 *
 * MUI applies this globally when `AppStateContext.themeVariant === "infuse-academy"`.
 * Page-level IA styling (hero layouts, gamification bars, progress rings, 3D
 * card hovers) lives in app/styles/infuse-academy.css under `.theme-ia`.
 */

const IA = {
  black: "#0a0a0f",
  dark: "#12121a",
  surface: "#1a1a2e",
  surface2: "#222240",
  border: "rgba(255,255,255,0.08)",

  accent1: "#6c63ff",
  accent2: "#ff6584",
  accent3: "#43e97b",
  accent4: "#38f9d7",
  accent5: "#f7971e",

  text: "#f0f0f5",
  textMuted: "#8888a0",
  textDim: "#55556a",
} as const;

const infuseAcademyTheme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: IA.accent1, contrastText: IA.text },
    secondary: { main: IA.accent2, contrastText: IA.text },
    success: { main: IA.accent3 },
    warning: { main: IA.accent5 },
    error: { main: IA.accent2 },
    background: {
      default: IA.black,
      paper: IA.surface,
    },
    text: {
      primary: IA.text,
      secondary: IA.textMuted,
      disabled: IA.textDim,
    },
    divider: IA.border,
  },
  typography: {
    fontFamily:
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    h1: { fontFamily: "'Space Grotesk', 'Inter', sans-serif", fontWeight: 700, letterSpacing: "-0.02em" },
    h2: { fontFamily: "'Space Grotesk', 'Inter', sans-serif", fontWeight: 700, letterSpacing: "-0.02em" },
    h3: { fontFamily: "'Space Grotesk', 'Inter', sans-serif", fontWeight: 700, letterSpacing: "-0.015em" },
    h4: { fontFamily: "'Space Grotesk', 'Inter', sans-serif", fontWeight: 600, letterSpacing: "-0.01em" },
    h5: { fontFamily: "'Space Grotesk', 'Inter', sans-serif", fontWeight: 600 },
    h6: { fontFamily: "'Space Grotesk', 'Inter', sans-serif", fontWeight: 600 },
    button: { fontWeight: 600, textTransform: "none", letterSpacing: 0 },
  },
  shape: { borderRadius: 12 },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: IA.surface,
          border: `1px solid ${IA.border}`,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundColor: IA.surface,
          border: `1px solid ${IA.border}`,
          borderRadius: 20,
          transition:
            "transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.4s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.4s",
          "&:hover": {
            transform: "translateY(-4px)",
            boxShadow: "0 16px 64px rgba(0,0,0,0.5), 0 0 40px rgba(108,99,255,0.25)",
            borderColor: "rgba(108,99,255,0.35)",
          },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 100, paddingInline: 20, paddingBlock: 10 },
        containedPrimary: {
          background: "linear-gradient(135deg, #6c63ff 0%, #ff6584 100%)",
          boxShadow: "0 8px 32px rgba(108,99,255,0.35)",
          "&:hover": {
            background: "linear-gradient(135deg, #6c63ff 0%, #ff6584 100%)",
            filter: "brightness(1.1)",
            boxShadow: "0 12px 40px rgba(108,99,255,0.5)",
          },
        },
        outlined: {
          borderColor: IA.border,
          color: IA.text,
          "&:hover": { borderColor: IA.accent1, backgroundColor: "rgba(108,99,255,0.08)" },
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: "rgba(10,10,15,0.7)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          borderBottom: `1px solid ${IA.border}`,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: IA.surface,
          backgroundImage: "none",
          border: `1px solid ${IA.border}`,
          borderRadius: 20,
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        root: { padding: 8 },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { borderRadius: 8, height: 8, backgroundColor: "rgba(255,255,255,0.08)" },
        bar: { background: "linear-gradient(135deg, #6c63ff 0%, #ff6584 100%)" },
      },
    },
    MuiCircularProgress: {
      styleOverrides: {
        root: { color: IA.accent1 },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          "& .MuiOutlinedInput-root": {
            backgroundColor: IA.dark,
            "& fieldset": { borderColor: IA.border },
            "&:hover fieldset": { borderColor: IA.accent1 },
            "&.Mui-focused fieldset": { borderColor: IA.accent1 },
          },
        },
      },
    },
  },
});

export default infuseAcademyTheme;
export { IA };
