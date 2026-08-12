import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function runWithLlmContext(context, callback) {
  return storage.run(context, callback);
}

export function getLlmContext() {
  return storage.getStore() ?? null;
}
