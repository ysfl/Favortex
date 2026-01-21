import type { AppState } from "./types";
import { normalizeState } from "./state";

export const STORAGE_KEY = "autoFavState";

export async function loadState(): Promise<AppState> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(result[STORAGE_KEY]);
}

export async function saveState(state: AppState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

export async function updateState(
  updater: (state: AppState) => AppState
): Promise<AppState> {
  const current = await loadState();
  const next = normalizeState(updater(current));
  await saveState(next);
  return next;
}
