import cron from "node-cron";
import { config } from "../config.js";
import { resetExpiredFreeQuotas } from "./quotaStore.js";

let task;

export function startQuotaCron() {
  if (task || !config.quotaCron.enabled) return task;
  task = cron.schedule(
    config.quotaCron.schedule,
    async () => {
      try {
        const count = await resetExpiredFreeQuotas();
        console.log(`Monthly free quota reset completed for ${count} account(s)`);
      } catch (error) {
        console.error("Monthly free quota reset failed:", error);
      }
    },
    { timezone: config.quotaCron.timezone },
  );
  return task;
}

export function stopQuotaCron() {
  task?.stop();
  task = undefined;
}
