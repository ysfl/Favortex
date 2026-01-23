import type { AppState } from "./types";
import { normalizeState } from "./state";

export const STORAGE_KEY = "favortexState";
export const LEGACY_STORAGE_KEY = "autoFavState";
const MAX_UPDATE_RETRIES = 3;

let updateQueue: Promise<unknown> = Promise.resolve();
const browserApi = (globalThis as { browser?: typeof chrome }).browser;
const storageArea = browserApi?.storage?.local ?? chrome.storage?.local;

function storageGet(key: string | string[]): Promise<Record<string, unknown>> {
  if (!storageArea) {
    return Promise.reject(new Error("Storage API unavailable"));
  }
  if (browserApi?.storage?.local && storageArea === browserApi.storage.local) {
    return storageArea.get(key) as Promise<Record<string, unknown>>;
  }
  return new Promise((resolve, reject) => {
    storageArea.get(key, (result) => {
      const error = chrome?.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(value: Record<string, unknown>): Promise<void> {
  if (!storageArea) {
    return Promise.reject(new Error("Storage API unavailable"));
  }
  if (browserApi?.storage?.local && storageArea === browserApi.storage.local) {
    return storageArea.set(value) as Promise<void>;
  }
  return new Promise((resolve, reject) => {
    storageArea.set(value, () => {
      const error = chrome?.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function serializeState(state: AppState) {
  return JSON.stringify(state);
}

export async function loadState(): Promise<AppState> {
  const result = await storageGet([STORAGE_KEY, LEGACY_STORAGE_KEY]);
  const stored = result[STORAGE_KEY] as Partial<AppState> | undefined;
  if (stored) {
    return normalizeState(stored);
  }
  const legacy = result[LEGACY_STORAGE_KEY] as Partial<AppState> | undefined;
  const normalizedLegacy = normalizeState(legacy);
  if (legacy) {
    await saveState(normalizedLegacy);
  }
  return normalizedLegacy;
}

export async function saveState(state: AppState): Promise<void> {
  await storageSet({ [STORAGE_KEY]: state });
}

export async function updateState(
  updater: (state: AppState) => AppState
): Promise<AppState> {
  const task = async () => {
    let latest = await loadState();
    for (let attempt = 0; attempt < MAX_UPDATE_RETRIES; attempt += 1) {
      const next = normalizeState(updater(latest));
      const serializedNext = serializeState(next);
      await saveState(next);
      const confirmed = await loadState();
      if (serializeState(confirmed) === serializedNext) {
        return confirmed;
      }
      latest = confirmed;
    }
    return latest;
  };

  const run = updateQueue.then(task, task);
  updateQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
