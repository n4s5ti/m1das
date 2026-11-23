import type { IncomingMessage, ServerResponse } from "node:http";
import { authorized, rotate } from "../sandbox.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req.headers.authorization)) {
    res.writeHead(401).end();
    return;
  }
  try {
    const result = await rotate();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  } catch (error) {
    console.error("Oracle rotation failed", error);
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Rotation failed; see function logs" }));
  }
}
