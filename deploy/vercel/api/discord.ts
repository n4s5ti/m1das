import { relay, type DmCache } from "../relay.js";

const cache: DmCache = {};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
    }

    const body = new Uint8Array(await request.arrayBuffer());
    const result = await relay({
      headers: request.headers,
      body,
      env: {
        APPROVAL_RELAY_PUBLIC_KEY: process.env.APPROVAL_RELAY_PUBLIC_KEY,
        APPROVAL_APPROVER_ID: process.env.APPROVAL_APPROVER_ID,
        DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
        M1DAS_BOT_TOKEN: process.env.M1DAS_BOT_TOKEN,
      },
      fetch,
      nowSeconds: Math.floor(Date.now() / 1000),
      cache,
    });
    return new Response(result.body.byteLength === 0 ? null : result.body, {
      status: result.status,
      headers: { "Content-Type": result.contentType },
    });
  },
};
