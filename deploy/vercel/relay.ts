import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

const DISCORD_API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://amatilife.com, 1) amati-card-relay";
const JSON_TYPE = "application/json";
const DM_PATH = "/users/@me/channels";
const MAX_BODY_BYTES = 1_000_000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SNOWFLAKE = /^[0-9]{1,32}$/;
const SEND_MESSAGE = /^\/channels\/([0-9]{1,32})\/messages$/;
const MESSAGE = /^\/channels\/([0-9]{1,32})\/messages\/[0-9]{1,32}$/;
const ADD_REACTION = /^\/channels\/([0-9]{1,32})\/messages\/[0-9]{1,32}\/reactions\/(?:%E2%9C%85|%E2%9D%8C)\/@me$/;
const LIST_REACTIONS = /^\/channels\/([0-9]{1,32})\/messages\/[0-9]{1,32}\/reactions\/(?:%E2%9C%85|%E2%9D%8C)\?limit=100$/;
const EMPTY_BODY = Buffer.alloc(0);

export type DmCache = { dm?: { approverId: string; channelId: string } };

type RelayInput = {
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
  env: {
    APPROVAL_RELAY_PUBLIC_KEY?: string;
    APPROVAL_APPROVER_ID?: string;
    DISCORD_BOT_TOKEN?: string;
    M1DAS_BOT_TOKEN?: string;
  };
  fetch: typeof fetch;
  nowSeconds: number;
  cache: DmCache;
};

type RelayResult = { status: number; body: Uint8Array<ArrayBuffer>; contentType: string };

function relayError(status: number, reason: string): RelayResult {
  console.error("Approval relay:", reason);
  return { status, body: Buffer.from(JSON.stringify({ error: reason })), contentType: JSON_TYPE };
}

function openDmAllowed(body: Uint8Array<ArrayBuffer>, approverId: string): boolean {
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  // The one allowed key and its numeric string value cannot contain a colon.
  // Reject duplicate keys rather than relying on Discord to choose the same value.
  if (text.indexOf(":") !== text.lastIndexOf(":")) return false;
  try {
    return JSON.parse(text)?.recipient_id === approverId;
  } catch {
    return false;
  }
}

function allowedChannel(method: string, path: string, contentType: string | null, size: number): string | undefined {
  if (method === "POST" && (contentType === JSON_TYPE || contentType?.startsWith("multipart/form-data; boundary="))) {
    return SEND_MESSAGE.exec(path)?.[1];
  }
  if (size !== 0) return undefined;
  if (method === "GET") return MESSAGE.exec(path)?.[1] ?? LIST_REACTIONS.exec(path)?.[1];
  if (method === "DELETE") return MESSAGE.exec(path)?.[1];
  if (method === "PUT") return ADD_REACTION.exec(path)?.[1];
  return undefined;
}

async function readDiscordBody(response: Response): Promise<Buffer<ArrayBuffer>> {
  if (!response.body) return EMPTY_BODY;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Discord response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 0) return EMPTY_BODY;
  const first = chunks[0];
  if (chunks.length === 1 && first.buffer instanceof ArrayBuffer) {
    return Buffer.from(first.buffer, first.byteOffset, first.byteLength);
  }
  return Buffer.concat(chunks, size);
}

function containsToken(body: Buffer, token: Buffer): boolean {
  let found = 0;
  // Check all offsets without stopping on a match or comparing token bytes early.
  for (let end = token.length; end <= body.length; end++) {
    found |= Number(timingSafeEqual(body.subarray(end - token.length, end), token));
  }
  return found !== 0;
}

export async function relay({ headers, body, env, fetch, nowSeconds, cache }: RelayInput): Promise<RelayResult> {
  const keyHex = env.APPROVAL_RELAY_PUBLIC_KEY ?? "";
  const approverId = env.APPROVAL_APPROVER_ID ?? "";
  const token = env.DISCORD_BOT_TOKEN || env.M1DAS_BOT_TOKEN || "";
  if (!/^[0-9a-f]{64}$/i.test(keyHex) || !SNOWFLAKE.test(approverId) || !/^[!-~]+$/.test(token)) {
    return relayError(503, "Relay is not configured");
  }
  if (body.byteLength > MAX_BODY_BYTES) return relayError(413, "Request body too large");

  const method = headers.get("x-amati-method") ?? "";
  const path = headers.get("x-amati-path") ?? "";
  const timestamp = headers.get("x-amati-timestamp") ?? "";
  const signature = headers.get("x-amati-signature") ?? "";
  const contentType = headers.get("content-type");
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method) || !/^\/[!-~]*$/.test(path) ||
      !/^[0-9]+$/.test(timestamp) || Math.abs(Number(timestamp) - nowSeconds) > 60 ||
      !/^[0-9a-f]{128}$/.test(signature)) {
    return relayError(401, "Invalid relay signature");
  }

  const hash = createHash("sha256").update(body).digest("hex");
  const message = Buffer.from(["amati-card-relay-v1", timestamp, method, path, contentType ?? "", hash].join("\n"));
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(keyHex, "hex")]), format: "der", type: "spki" });
  if (!verify(null, message, key, Buffer.from(signature, "hex"))) return relayError(401, "Invalid relay signature");

  let channelId: string | undefined;
  if (method === "POST" && path === DM_PATH) {
    if (contentType !== JSON_TYPE || !openDmAllowed(body, approverId)) return relayError(403, "Discord request not allowed");
  } else {
    channelId = allowedChannel(method, path, contentType, body.byteLength);
    if (!channelId) return relayError(403, "Discord request not allowed");
  }

  const credential = Buffer.from(token);
  async function requestDiscord(discordMethod: string, discordPath: string, type: string | null, bytes: Uint8Array<ArrayBuffer>) {
    const upstreamHeaders = new Headers({ Authorization: `Bot ${token}`, "User-Agent": USER_AGENT });
    if (type !== null) upstreamHeaders.set("Content-Type", type);
    const response = await fetch(DISCORD_API + discordPath, {
      method: discordMethod,
      headers: upstreamHeaders,
      body: bytes.byteLength === 0 ? undefined : bytes,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.redirected || [301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      throw new Error("Discord redirect");
    }
    const responseBody = await readDiscordBody(response);
    if (containsToken(responseBody, credential)) throw new Error("Discord echoed credentials");
    return { status: response.status, body: responseBody, contentType: JSON_TYPE };
  }

  try {
    if (channelId) {
      if (cache.dm?.approverId !== approverId) {
        const result = await requestDiscord("POST", DM_PATH, JSON_TYPE, Buffer.from(JSON.stringify({ recipient_id: approverId })));
        if (result.status < 200 || result.status >= 300) return relayError(502, "Discord DM lookup failed");
        const dm = JSON.parse(result.body.toString("utf8"));
        if (dm?.type !== 1 || typeof dm.id !== "string" || !SNOWFLAKE.test(dm.id) ||
            !Array.isArray(dm.recipients) || dm.recipients.length !== 1 || dm.recipients[0]?.id !== approverId) {
          return relayError(502, "Invalid Discord DM response");
        }
        cache.dm = { approverId, channelId: dm.id };
      }
      if (cache.dm.channelId !== channelId) return relayError(403, "Discord channel not allowed");
    }
    return await requestDiscord(method, path, contentType, body);
  } catch {
    return relayError(502, "Discord request failed");
  }
}
