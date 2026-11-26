import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { relay, type DmCache } from "./relay.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const APPROVER = "123456789012345678";
const DM = "223456789012345678";
const MESSAGE = "323456789012345678";
const TOKEN = "test-discord-bot-token.not-a-real-credential";
const NOW = 1_795_685_400;
const ORIGIN = "https://discord.com/api/v10";
const OPEN_DM = "/users/@me/channels";
const APPROVER_BODY = Buffer.from(JSON.stringify({ recipient_id: APPROVER }));
const MESSAGES = `/channels/${DM}/messages`;
const MESSAGE_PATH = `${MESSAGES}/${MESSAGE}`;
const REACTION_PATH = `${MESSAGE_PATH}/reactions`;
const JSON_TYPE = "application/json";
const EMPTY = Buffer.alloc(0);
const ENV = {
  APPROVAL_RELAY_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"),
  APPROVAL_APPROVER_ID: APPROVER,
  DISCORD_BOT_TOKEN: TOKEN,
};

type Input = Parameters<typeof relay>[0];
type DiscordCall = { url: Parameters<typeof fetch>[0]; init?: RequestInit };

function signedHeaders(method: string, path: string, body = EMPTY, contentType?: string, timestamp = String(NOW)): Headers {
  const hash = createHash("sha256").update(body).digest("hex");
  const message = Buffer.from(`amati-card-relay-v1\n${timestamp}\n${method}\n${path}\n${contentType ?? ""}\n${hash}`);
  const headers = new Headers({
    "X-Amati-Method": method,
    "X-Amati-Path": path,
    "X-Amati-Timestamp": timestamp,
    "X-Amati-Signature": sign(null, message, privateKey).toString("hex"),
  });
  if (contentType !== undefined) headers.set("Content-Type", contentType);
  return headers;
}

function fakeDiscord(...responses: Array<Response | (() => Response)>) {
  const calls: DiscordCall[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected Discord call");
    return typeof response === "function" ? response() : response;
  };
  return { calls, fakeFetch };
}

function dmResponse(type = 1, recipients = [{ id: APPROVER }], id = DM): Response {
  return Response.json({ id, type, recipients });
}

async function request(headers: Headers, fetch: typeof globalThis.fetch, body: Input["body"] = EMPTY, options: Partial<Pick<Input, "env" | "cache">> = {}) {
  const result = await relay({ headers, fetch, body, env: ENV, cache: {}, nowSeconds: NOW, ...options });
  assert.equal(result.contentType, JSON_TYPE);
  assert.equal(Buffer.from(result.body).includes(TOKEN), false, "relay response exposed the token");
  return result;
}

function assertForwarded(call: DiscordCall, method: string, path: string, body: Buffer, contentType?: string, token = TOKEN): void {
  assert.equal(call.url, ORIGIN + path);
  assert.equal(call.init?.method, method);
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("Authorization"), `Bot ${token}`);
  assert.equal(headers.get("User-Agent"), "DiscordBot (https://amatilife.com, 1) amati-card-relay");
  assert.equal(headers.get("Content-Type"), contentType ?? null);
  assert.deepEqual(call.init?.body, body.byteLength === 0 ? undefined : body);
  assert.equal(call.init?.redirect, "error");
  assert.ok(call.init?.signal instanceof AbortSignal);
}

const multipart = "multipart/form-data; boundary=test-boundary";
const routes = [
  { method: "POST", path: OPEN_DM, body: APPROVER_BODY, type: JSON_TYPE, status: 200 },
  { method: "POST", path: MESSAGES, body: Buffer.from('{ "content": "hello" }\n'), type: JSON_TYPE, status: 201 },
  { method: "GET", path: MESSAGE_PATH, body: EMPTY, status: 200 },
  { method: "DELETE", path: MESSAGE_PATH, body: EMPTY, status: 204 },
  { method: "PUT", path: `${REACTION_PATH}/%E2%9C%85/@me`, body: EMPTY, status: 204 },
  { method: "GET", path: `${REACTION_PATH}/%E2%9D%8C?limit=100`, body: EMPTY, status: 200 },
  { method: "POST", path: MESSAGES, body: Buffer.from([0x00, 0xff, 0x0d, 0x0a]), type: multipart, status: 201 },
];
for (const { method, path, body, type, status } of routes) {
  test(`forwards ${method} ${path}${type ? ` with ${type}` : ""}`, async () => {
    const upstreamBody = status === 204 ? null : Buffer.from('{ "from": "Discord" }\n');
    const response = new Response(upstreamBody, { status });
    const { calls, fakeFetch } = fakeDiscord(...(path === OPEN_DM ? [response] : [dmResponse(), response]));
    const result = await request(signedHeaders(method, path, body, type), fakeFetch, body);
    assert.equal(result.status, status);
    assert.deepEqual(result.body, upstreamBody ?? EMPTY);
    assert.equal(calls.length, path === OPEN_DM ? 1 : 2);
    if (path !== OPEN_DM) assertForwarded(calls[0], "POST", OPEN_DM, APPROVER_BODY, JSON_TYPE);
    assertForwarded(calls.at(-1)!, method, path, body, type);
  });
}

test("the validated DM channel is reused", async () => {
  const cache: DmCache = {};
  const { calls, fakeFetch } = fakeDiscord(dmResponse(), Response.json({ id: MESSAGE }), new Response(null, { status: 204 }));
  assert.equal((await request(signedHeaders("GET", MESSAGE_PATH), fakeFetch, EMPTY, { cache })).status, 200);
  assert.equal((await request(signedHeaders("DELETE", MESSAGE_PATH), fakeFetch, EMPTY, { cache })).status, 204);
  assert.deepEqual(calls.map(({ url }) => url), [ORIGIN + OPEN_DM, ORIGIN + MESSAGE_PATH, ORIGIN + MESSAGE_PATH]);
});

test("uses M1DAS_BOT_TOKEN only when DISCORD_BOT_TOKEN is empty", async () => {
  const fallback = "fallback-token.not-a-real-credential";
  const headers = signedHeaders("POST", OPEN_DM, APPROVER_BODY, JSON_TYPE);
  const { calls, fakeFetch } = fakeDiscord(dmResponse(), dmResponse());
  for (const discordToken of [TOKEN, ""]) {
    const env = { ...ENV, DISCORD_BOT_TOKEN: discordToken, M1DAS_BOT_TOKEN: fallback };
    assert.equal((await request(headers, fakeFetch, APPROVER_BODY, { env })).status, 200);
  }
  assertForwarded(calls[0], "POST", OPEN_DM, APPROVER_BODY, JSON_TYPE);
  assertForwarded(calls[1], "POST", OPEN_DM, APPROVER_BODY, JSON_TYPE, fallback);
});

for (const [name, header, value] of [
  ["bad signature", "X-Amati-Signature", "0".repeat(128)],
  ["malformed signature", "X-Amati-Signature", "A".repeat(128)],
  ["tampered path", "X-Amati-Path", `${MESSAGES}/123`],
  ["tampered content type", "Content-Type", "text/plain"],
  ["malformed timestamp", "X-Amati-Timestamp", "+1795685400"],
]) {
  test(`${name} gives 401 before forwarding`, async () => {
    const { calls, fakeFetch } = fakeDiscord();
    const headers = signedHeaders("POST", MESSAGES, APPROVER_BODY, JSON_TYPE);
    headers.set(header, value);
    assert.equal((await request(headers, fakeFetch, APPROVER_BODY)).status, 401);
    assert.deepEqual(calls, []);
  });
}

test("tampered body gives 401 before forwarding", async () => {
  const { calls, fakeFetch } = fakeDiscord();
  const headers = signedHeaders("POST", OPEN_DM, APPROVER_BODY, JSON_TYPE);
  assert.equal((await request(headers, fakeFetch, Buffer.concat([APPROVER_BODY, Buffer.from("\n")]))).status, 401);
  assert.deepEqual(calls, []);
});

for (const offset of [-61, 61]) {
  test(`signed timestamp ${offset} seconds from now gives 401`, async () => {
    const { calls, fakeFetch } = fakeDiscord();
    const headers = signedHeaders("GET", MESSAGE_PATH, EMPTY, undefined, String(NOW + offset));
    assert.equal((await request(headers, fakeFetch)).status, 401);
    assert.deepEqual(calls, []);
  });
}

test("accepts a signed timestamp exactly 60 seconds old", async () => {
  const { calls, fakeFetch } = fakeDiscord(dmResponse());
  const headers = signedHeaders("POST", OPEN_DM, APPROVER_BODY, JSON_TYPE, String(NOW - 60));
  assert.equal((await request(headers, fakeFetch, APPROVER_BODY)).status, 200);
  assert.equal(calls.length, 1);
});

for (const [name, env] of [
  ["missing", {}],
  ["public key", { ...ENV, APPROVAL_RELAY_PUBLIC_KEY: "bad" }],
  ["approver id", { ...ENV, APPROVAL_APPROVER_ID: "invalid" }],
  ["bot token", { ...ENV, DISCORD_BOT_TOKEN: "bad token" }],
] as const) {
  test(`invalid configuration (${name}) gives 503 before size and signature checks`, async () => {
    const { calls, fakeFetch } = fakeDiscord();
    assert.equal((await request(new Headers(), fakeFetch, Buffer.alloc(1_000_001), { env })).status, 503);
    assert.deepEqual(calls, []);
  });
}

test("an oversized request gives 413 before the signature check", async () => {
  const { calls, fakeFetch } = fakeDiscord();
  assert.equal((await request(new Headers(), fakeFetch, Buffer.alloc(1_000_001))).status, 413);
  assert.deepEqual(calls, []);
});

const denied = [
  { name: "unlisted path", method: "GET", path: "/users/@me" },
  { name: "wrong method", method: "PATCH", path: MESSAGE_PATH },
  { name: "extra query", method: "GET", path: `${REACTION_PATH}/%E2%9D%8C?limit=100&after=123` },
  { name: "different emoji", method: "PUT", path: `${REACTION_PATH}/%E2%9D%A4/@me` },
  { name: "trailing slash", method: "GET", path: `${MESSAGE_PATH}/` },
  { name: "wrong recipient", method: "POST", path: OPEN_DM, body: '{"recipient_id":"123"}', type: JSON_TYPE },
  { name: "additional DM body field", method: "POST", path: OPEN_DM, body: `{"recipient_id":"${APPROVER}","other":true}`, type: JSON_TYPE },
  { name: "duplicate recipient", method: "POST", path: OPEN_DM, body: `{"recipient_id":"123","recipient_id":"${APPROVER}"}`, type: JSON_TYPE },
  { name: "nonempty read body", method: "GET", path: MESSAGE_PATH, body: "{}", type: JSON_TYPE },
  { name: "wrong message content type", method: "POST", path: MESSAGES, body: "{}", type: "text/plain" },
];
for (const { name, method, path, body, type } of denied) {
  test(`${name} gives 403 before calling Discord`, async () => {
    const { calls, fakeFetch } = fakeDiscord();
    const bytes = body === undefined ? EMPTY : Buffer.from(body);
    assert.equal((await request(signedHeaders(method, path, bytes, type), fakeFetch, bytes)).status, 403);
    assert.deepEqual(calls, []);
  });
}

test("a different channel is denied after checking the approver DM", async () => {
  const { calls, fakeFetch } = fakeDiscord(dmResponse());
  assert.equal((await request(signedHeaders("GET", "/channels/123/messages/456"), fakeFetch)).status, 403);
  assert.equal(calls.length, 1);
  assertForwarded(calls[0], "POST", OPEN_DM, APPROVER_BODY, JSON_TYPE);
});

for (const [name, response] of [
  ["wrong channel type", dmResponse(3)],
  ["wrong recipient", dmResponse(1, [{ id: "456" }])],
  ["multiple recipients", dmResponse(1, [{ id: APPROVER }, { id: "456" }])],
  ["malformed channel id", dmResponse(1, [{ id: APPROVER }], "not-a-snowflake")],
  ["upstream lookup error", new Response("{}", { status: 429 })],
] as const) {
  test(`DM lookup rejects ${name} and does not cache a channel`, async () => {
    const { calls, fakeFetch } = fakeDiscord(response);
    const cache: DmCache = {};
    assert.equal((await request(signedHeaders("GET", MESSAGE_PATH), fakeFetch, EMPTY, { cache })).status, 502);
    assert.equal(calls.length, 1);
    assert.deepEqual(cache, {});
  });
}

for (const status of [404, 429]) {
  test(`passes through Discord status ${status} and its exact body`, async () => {
    const bytes = Buffer.from('{ "error": "from Discord" }\n');
    const { calls, fakeFetch } = fakeDiscord(dmResponse(), new Response(bytes, { status }));
    const result = await request(signedHeaders("GET", MESSAGE_PATH), fakeFetch);
    assert.equal(result.status, status);
    assert.deepEqual(result.body, bytes);
    assert.equal(calls.length, 2);
  });
}

for (const [name, respond] of [
  ["network failure", () => { throw new Error(TOKEN); }],
  ["redirect", () => Response.redirect("https://example.invalid", 302)],
  ["oversized response", () => new Response(new Uint8Array(1_000_001))],
  ["Discord echoes the token", () => Response.json({ detail: TOKEN }, { status: 429 })],
] as const) {
  test(`${name} produces only a short 502 error`, async (t) => {
    const log = t.mock.method(console, "error", () => {});
    const { calls, fakeFetch } = fakeDiscord(respond);
    const result = await request(signedHeaders("POST", OPEN_DM, APPROVER_BODY, JSON_TYPE), fakeFetch, APPROVER_BODY);
    assert.equal(result.status, 502);
    assert.deepEqual(JSON.parse(Buffer.from(result.body).toString("utf8")), { error: "Discord request failed" });
    assert.equal(calls.length, 1);
    assert.deepEqual(log.mock.calls.map(({ arguments: args }) => args), [["Approval relay:", "Discord request failed"]]);
  });
}

test("an eight-second Discord timeout gives 502", async (t) => {
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const { calls, fakeFetch } = fakeDiscord(() => {
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    calls[0].init?.signal?.throwIfAborted();
    assert.fail("Discord fetch did not receive the timeout signal");
  });
  const result = await request(signedHeaders("POST", OPEN_DM, APPROVER_BODY, JSON_TYPE), fakeFetch, APPROVER_BODY);
  assert.equal(result.status, 502);
  assert.deepEqual(timeout.mock.calls.map(({ arguments: args }) => args), [[8_000]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.signal, controller.signal);
});
