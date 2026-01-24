import { useCallback, useEffect, useState } from "react";
import type { AppState } from "./types";
import { loadState, updateState, LEGACY_STORAGE_KEY, STORAGE_KEY } from "./storage";
import { normalizeState } from "./state";
import { DEFAULT_THEME_ID } from "./theme";

export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);

  const refresh = useCallback(async () => {
    const latest = await loadState();
    setState(latest);
  }, []);

  useEffect(() => {
    void refresh();
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === "local" && (changes[STORAGE_KEY] || changes[LEGACY_STORAGE_KEY])) {
        const next = (changes[STORAGE_KEY]?.newValue ??
          changes[LEGACY_STORAGE_KEY]?.newValue) as Partial<AppState> | undefined;
        setState(normalizeState(next));
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refresh]);

  useEffect(() => {
    const theme = state?.theme ?? DEFAULT_THEME_ID;
    document.documentElement.dataset.theme = theme;
  }, [state?.theme]);

  useEffect(() => {
    const mode = state?.ui.colorMode ?? "system";
    const root = document.documentElement;
    const media =
      typeof window !== "undefined" && "matchMedia" in window
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    const apply = (isDark: boolean) => {
      root.dataset.mode = isDark ? "dark" : "light";
      root.style.colorScheme = isDark ? "dark" : "light";
    };

    if (mode === "system") {
      apply(media?.matches ?? false);
      if (media) {
        const handler = (event: MediaQueryListEvent) => apply(event.matches);
        media.addEventListener("change", handler);
        return () => media.removeEventListener("change", handler);
      }
      return undefined;
    }

    apply(mode === "dark");
    return undefined;
  }, [state?.ui.colorMode]);

  const update = useCallback(async (updater: (state: AppState) => AppState) => {
    const next = await updateState(updater);
    setState(next);
    return next;
  }, []);

  return { state, refresh, update };
}
