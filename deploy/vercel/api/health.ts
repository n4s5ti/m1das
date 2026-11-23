import type { IncomingMessage, ServerResponse } from "node:http";
import { authorized, health } from "../sandbox.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req.headers.authorization)) {
    res.writeHead(401).end();
    return;
  }
  try {
    const result = await health();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  } catch (error) {
    console.error("Oracle health failed", error);
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Health check failed; see function logs" }));
  }
}
