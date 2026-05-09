import { getCloudflareContext } from "@opennextjs/cloudflare";

export function getDb(): D1Database {
  return getCloudflareContext().env.DB;
}

export function getEnv() {
  return getCloudflareContext().env;
}

export function getCtx(): ExecutionContext {
  return getCloudflareContext().ctx;
}
