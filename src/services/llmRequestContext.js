import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function runWithLlmContext(context, callback) {
  return storage.run(context, callback);
}

export function getLlmContext() {
  return storage.getStore() ?? null;
}

export function setLlmFeature(feature) {
  const context = storage.getStore();
  if (context && typeof feature === "string" && feature.trim()) {
    context.feature = feature.trim().slice(0, 160);
  }
}
