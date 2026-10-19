// The Cloudflare Worker: the app over D1 (binding `DB`). One app per isolate; the schema
// is created on the isolate's first request.

import { createApp } from "../app.ts";
import { createDeps, type Env } from "../config.ts";
import { type D1Database, d1Storage } from "../storage/d1.ts";

interface WorkerEnv extends Env {
  DB: D1Database;
}

let app: Promise<{ fetch: (request: Request) => Response | Promise<Response> }> | undefined;

async function build(env: WorkerEnv) {
  const storage = d1Storage(env.DB);
  await storage.migrate();
  return createApp(await createDeps({ env, storage }));
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    app ??= build(env).catch((error: unknown) => {
      app = undefined;
      throw error;
    });
    return (await app).fetch(request);
  },
};
