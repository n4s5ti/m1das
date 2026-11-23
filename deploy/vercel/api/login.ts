import type { IncomingMessage, ServerResponse } from "node:http";
import { authorized, login } from "../sandbox.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req.headers.authorization)) {
    res.writeHead(401).end();
    return;
  }
  try {
    const result = await login();
    if (result) res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
    else res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "A rotation or login is running; try again shortly" }));
  } catch (error) {
    console.error("Oracle login page failed", error);
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Login page failed; see function logs" }));
  }
}
