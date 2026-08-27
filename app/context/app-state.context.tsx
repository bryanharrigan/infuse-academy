import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
  useCallback,
  useMemo,
} from "react";

export type ThemeVariant =
  | "infuse-academy"
  | "experimental"
  | "psbi";
const THEME_STORAGE_KEY = "ia:theme-variant";

/**
 * Branded variants share the IA (Infuse Academy) layout + components.
 *
 * NOTE: "experimental" IS treated as branded for layout purposes — it
 * inherits the IA chrome (header, hub-grid card styling, etc.) on every
 * route EXCEPT its own dedicated /learning-hub-experimental page, which
 * carries its own complete layout. Without this, /catalog and /my-courses
 * render unstyled (no card borders, no IA header) when the experimental
 * theme is active because they were authored against `body.theme-ia` rules.
 *
 * The experimental hub route stays distinct via its own `body.theme-experimental`
 * class + the `exp-*` selectors, which override the IA defaults wherever
 * needed.
 */
export function isBrandedVariant(v: ThemeVariant): boolean {
  return v === "infuse-academy" || v === "experimental";
}

type AppStateContextType = {
  isAnotherModalOpen: boolean;
  setModalOpen: (isOpen: boolean) => void;
  themeVariant: ThemeVariant;
  setThemeVariant: (v: ThemeVariant) => void;
  toggleThemeVariant: () => void;
};

const AppStateContext = createContext<AppStateContextType | undefined>(
  undefined
);

export const AppStateProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [isAnotherModalOpen, setIsAnotherModalOpen] = useState(false);
  // SSR-safe initial state. The new product default is "experimental" so a
  // first-time learner lands on the liquid-glass hub. Returning users with
  // a persisted choice in localStorage have it restored on hydration by
  // the effect below — that path always wins over the default.
  const [themeVariant, setThemeVariantState] =
    useState<ThemeVariant>("experimental");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "infuse-academy" || stored === "experimental" || stored === "psbi") {
        setThemeVariantState(stored);
      }
    } catch {
      // localStorage may be blocked; fall back to default
    }
  }, []);

  // Mirror the variant onto <body> so CSS can scope branded styles.
  //   "infuse-academy" → body has `theme-ia`
  //   "experimental"   → body has `theme-ia theme-experimental` (inherits IA
  //                      layout then overrides with experimental styles)
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("theme-ia", isBrandedVariant(themeVariant));
    document.body.classList.toggle(
      "theme-experimental",
      themeVariant === "experimental"
    );
  }, [themeVariant]);

  const setThemeVariant = useCallback((v: ThemeVariant) => {
    setThemeVariantState(v);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, v);
    } catch {
      // ignore
    }
  }, []);

  const toggleThemeVariant = useCallback(() => {
    setThemeVariantState((prev) => {
      const next = prev === "infuse-academy" ? "experimental" : "infuse-academy";
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const setModalOpen = useCallback((isOpen: boolean) => {
    setIsAnotherModalOpen(isOpen);
  }, []);

  const contextValue = useMemo(
    () => ({
      isAnotherModalOpen,
      setModalOpen,
      themeVariant,
      setThemeVariant,
      toggleThemeVariant,
    }),
    [
      isAnotherModalOpen,
      setModalOpen,
      themeVariant,
      setThemeVariant,
      toggleThemeVariant,
    ]
  );

  return (
    <AppStateContext.Provider value={contextValue}>
      {children}
    </AppStateContext.Provider>
  );
};

export const useAppStateContext = (): AppStateContextType => {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error(
      "useAppStateContext must be used within an AppStateProvider"
    );
  }
  return context;
};
