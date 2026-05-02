import { createTheme } from "@mui/material/styles";

/**
 * Experimental MUI theme — "Liquid Glassmorphism".
 *
 * A bold visual departure from the IA / RadNet themes. The page itself
 * (app/routes/learning-hub-experimental.tsx + app/styles/experimental.css)
 * carries the heavy lifting — animated aurora gradient backgrounds, frosted
 * glass cards, swirling text whirlpools, particle confetti, and a holographic
 * gamification HUD. This MUI theme just makes the few <Button>/<Dialog>
 * surfaces we still use feel native to that world.
 *
 * Palette: deep ink-violet base + iridescent aqua/magenta/lemon accents.
 *
 * NOTE: this theme is NOT a "branded" variant — it does not inherit from
 * body.theme-ia. See app-state.context.tsx for the dispatch logic.
 */

const EXP = {
  // Base — deep saturated ink with a violet undertone
  bg: "#06061a",
  bgAlt: "#0c0c2a",
  surface: "rgba(255,255,255,0.06)",
  surfaceStrong: "rgba(255,255,255,0.12)",
  border: "rgba(255,255,255,0.18)",
  borderStrong: "rgba(255,255,255,0.32)",

  // Iridescent accents
  aqua: "#5eead4",
  cyan: "#22d3ee",
  magenta: "#f0abfc",
  pink: "#ec4899",
  violet: "#a78bfa",
  indigo: "#818cf8",
  lemon: "#fde68a",
  coral: "#fb923c",

  // Text
  text: "#f5f3ff",
  textMuted: "rgba(245,243,255,0.72)",
  textDim: "rgba(245,243,255,0.45)",
} as const;

const experimentalTheme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: EXP.aqua, dark: EXP.cyan, contrastText: "#06061a" },
    secondary: { main: EXP.magenta, dark: EXP.pink, contrastText: "#06061a" },
    success: { main: EXP.aqua },
    warning: { main: EXP.lemon },
    error: { main: EXP.pink },
    info: { main: EXP.violet },
    background: { default: EXP.bg, paper: EXP.surface },
    text: { primary: EXP.text, secondary: EXP.textMuted, disabled: EXP.textDim },
    divider: EXP.border,
  },
  typography: {
    fontFamily:
      "'Space Grotesk', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    h1: {
      fontFamily: "'Space Grotesk', 'Inter', sans-serif",
      fontWeight: 700,
      letterSpacing: "-0.03em",
    },
    h2: {
      fontFamily: "'Space Grotesk', 'Inter', sans-serif",
      fontWeight: 700,
      letterSpacing: "-0.02em",
    },
    h3: {
      fontFamily: "'Space Grotesk', 'Inter', sans-serif",
      fontWeight: 700,
      letterSpacing: "-0.01em",
    },
    h4: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700 },
    h5: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 },
    h6: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 },
    button: {
      fontWeight: 700,
      textTransform: "none",
      letterSpacing: "0.02em",
    },
  },
  shape: { borderRadius: 20 },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: EXP.surface,
          backdropFilter: "blur(24px) saturate(160%)",
          WebkitBackdropFilter: "blur(24px) saturate(160%)",
          border: `1px solid ${EXP.border}`,
          color: EXP.text,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundColor: EXP.surface,
          backdropFilter: "blur(24px) saturate(160%)",
          WebkitBackdropFilter: "blur(24px) saturate(160%)",
          border: `1px solid ${EXP.border}`,
          borderRadius: 24,
          transition:
            "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.5s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.5s",
          "&:hover": {
            transform: "translateY(-6px)",
            borderColor: EXP.borderStrong,
            boxShadow:
              "0 24px 80px rgba(94,234,212,0.18), 0 8px 28px rgba(240,171,252,0.18)",
          },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          paddingInline: 22,
          paddingBlock: 11,
          fontWeight: 700,
        },
        containedPrimary: {
          background: `linear-gradient(135deg, ${EXP.aqua} 0%, ${EXP.cyan} 50%, ${EXP.violet} 100%)`,
          color: "#06061a",
          boxShadow: "0 10px 30px rgba(94,234,212,0.35)",
          "&:hover": {
            background: `linear-gradient(135deg, ${EXP.aqua} 0%, ${EXP.cyan} 50%, ${EXP.violet} 100%)`,
            filter: "brightness(1.08) saturate(1.1)",
            boxShadow: "0 14px 40px rgba(94,234,212,0.55)",
          },
        },
        containedSecondary: {
          background: `linear-gradient(135deg, ${EXP.magenta} 0%, ${EXP.pink} 100%)`,
          color: "#06061a",
          boxShadow: "0 10px 30px rgba(240,171,252,0.35)",
          "&:hover": {
            background: `linear-gradient(135deg, ${EXP.magenta} 0%, ${EXP.pink} 100%)`,
            filter: "brightness(1.08)",
            boxShadow: "0 14px 40px rgba(240,171,252,0.55)",
          },
        },
        outlined: {
          borderColor: EXP.borderStrong,
          color: EXP.text,
          backdropFilter: "blur(12px)",
          backgroundColor: "rgba(255,255,255,0.04)",
          "&:hover": {
            borderColor: EXP.aqua,
            backgroundColor: "rgba(94,234,212,0.08)",
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: "rgba(12,12,42,0.85)",
          backdropFilter: "blur(40px) saturate(180%)",
          WebkitBackdropFilter: "blur(40px) saturate(180%)",
          border: `1px solid ${EXP.borderStrong}`,
          borderRadius: 28,
          color: EXP.text,
        },
      },
    },
    MuiCircularProgress: {
      styleOverrides: { root: { color: EXP.aqua } },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: {
          backgroundColor: "rgba(255,255,255,0.08)",
          height: 8,
          borderRadius: 999,
        },
        bar: {
          background: `linear-gradient(90deg, ${EXP.aqua}, ${EXP.violet}, ${EXP.magenta})`,
          borderRadius: 999,
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: "rgba(6,6,26,0.95)",
          border: `1px solid ${EXP.borderStrong}`,
          backdropFilter: "blur(12px)",
          fontWeight: 500,
        },
      },
    },
  },
});

export default experimentalTheme;
