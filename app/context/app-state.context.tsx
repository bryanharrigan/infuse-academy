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
  | "default"
  | "infuse-academy"
  | "radnet"
  | "experimental";
const THEME_STORAGE_KEY = "ia:theme-variant";

/**
 * Branded variants share the IA (Infuse Academy) layout + components.
 *
 * NOTE: "experimental" is intentionally NOT a branded variant — it has its own
 * standalone layout, palette, typography, and route (/learning-hub-experimental)
 * and does not inherit from `body.theme-ia` styles.
 */
export function isBrandedVariant(v: ThemeVariant): boolean {
  return v === "infuse-academy" || v === "radnet";
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
  // We can't read localStorage on the server, so SSR renders "default" and
  // the effect below flips to the persisted choice on hydration.
  const [themeVariant, setThemeVariantState] =
    useState<ThemeVariant>("default");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (
        stored === "infuse-academy" ||
        stored === "radnet" ||
        stored === "experimental" ||
        stored === "default"
      ) {
        setThemeVariantState(stored);
      }
    } catch {
      // localStorage may be blocked; fall back to default
    }
  }, []);

  // Mirror the variant onto <body> so CSS can scope branded styles.
  //   "infuse-academy" → body has `theme-ia`
  //   "radnet"         → body has `theme-ia theme-radnet` (inherits IA layout,
  //                      then .theme-radnet overrides the IA color variables)
  //   "experimental"   → body has `theme-experimental` (its own standalone
  //                      stylesheet — does NOT inherit from theme-ia)
  //   "default"        → none of the above
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("theme-ia", isBrandedVariant(themeVariant));
    document.body.classList.toggle("theme-radnet", themeVariant === "radnet");
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
      const next = prev === "infuse-academy" ? "default" : "infuse-academy";
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
