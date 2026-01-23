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

  const update = useCallback(async (updater: (state: AppState) => AppState) => {
    const next = await updateState(updater);
    setState(next);
    return next;
  }, []);

  return { state, refresh, update };
}
