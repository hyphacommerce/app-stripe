// The Node server: the app over SQLite (`DATABASE_PATH`, `./stripe-app.sqlite` by
// default), on `PORT` (3000) at `HOST` (0.0.0.0). Requests and answers go through Web
// `Request` / `Response`, so the app itself is the Worker's.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createApp } from "../app.ts";
import { createDeps, type Env } from "../config.ts";
import { sqliteStorage } from "../storage/sqlite.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export async function startServer(env: Env & Record<string, string | undefined>) {
  const storage = sqliteStorage(env.DATABASE_PATH ?? "stripe-app.sqlite");
  await storage.migrate();
  const app = createApp(await createDeps({ env, storage }));
  const server = createServer((req, res) => {
    void handle(app.fetch, req, res, env);
  });
  const port = Number(env.PORT ?? 3000);
  const host = env.HOST ?? "0.0.0.0";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server;
}

async function handle(
  fetch: (request: Request) => Response | Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
  env: Record<string, string | undefined>,
) {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(bytes);
    }
    // The public URL's origin, so the app sees the URLs it was called at.
    const base = env.APP_URL ?? `http://${req.headers.host ?? "localhost"}`;
    const url = new URL(req.url ?? "/", base);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    const method = req.method ?? "GET";
    const request = new Request(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const response = await fetch(request);
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
      out[name] = name === "set-cookie" ? response.headers.getSetCookie() : value;
    });
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(
      JSON.stringify({ level: "error", message: "request failed", error: String(error) }),
    );
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "internal_error", error: "something went wrong" }));
  }
}

if (import.meta.main) {
  const server = await startServer(process.env);
  const address = server.address();
  console.log(
    JSON.stringify({
      level: "info",
      message: "listening",
      address:
        typeof address === "object" && address ? `${address.address}:${address.port}` : address,
    }),
  );
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
