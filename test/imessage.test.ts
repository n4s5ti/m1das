import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelSink } from "../src/core/channel.ts";

const fake = vi.hoisted(() => ({ events: [] as unknown[], sent: [] as unknown[] }));
vi.mock("@photon-ai/chat-adapter-imessage", () => ({
  createiMessageAdapter: () => ({
    app: { messages: { async *[Symbol.asyncIterator]() { for (const event of fake.events) yield event; } }, stop: async () => {} },
    initialize: async () => {},
    encodeThreadId: ({ chatGuid, phone }: { chatGuid: string; phone?: string }) => `imessage:${chatGuid}${phone ? `~${phone}` : ""}`,
    isDM: (threadId: string) => threadId.includes(";-;"),
    parseMessage: (message: { content: { text?: string } }) => ({ text: message.content.text ?? "" }),
    postMessage: async (threadId: string, message: unknown) => { fake.sent.push({ threadId, message }); return { id: "sent" }; },
    openDM: async (person: string) => `imessage:iMessage;-;${person}`,
    addReaction: async () => {}, removeReaction: async () => {},
  }),
}));
import { createChannel } from "../src/channels/imessage/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); fake.events.length = 0; fake.sent.length = 0; });

describe("iMessage", () => {
  it("stores and translates a DM, retaining the line for replies and downloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pots-imessage-")); dirs.push(dir);
    const secrets = join(dir, "imessage.env");
    writeFileSync(secrets, "IMESSAGE_PROJECT_ID=project\nIMESSAGE_PROJECT_SECRET=secret\n");
    const space = { id: "iMessage;-;+123", phone: "+456" };
    fake.events.push([space, { id: "one", space, direction: "inbound", sender: { id: "+123" }, timestamp: new Date(1000), content: { type: "attachment", name: "x.txt", mimeType: "text/plain", size: 1, read: async () => Buffer.from("x") } }]);
    const received: unknown[] = [];
    const sink: ChannelSink = { receive: async (_id, raw) => { received.push(raw); }, newestMessage: async () => undefined, threads: async () => [], places: async () => [], lastAlive: () => undefined, form: async () => undefined, formOpened: async () => {}, formOpening: async () => undefined, log: () => {} };
    const channel = createChannel({ id: "imessage", type: "imessage", secrets }, { botDir: dir, botName: "Pots", log: () => {} });
    await channel.start(sink);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const [event] = await channel.translate(received[0]);
    expect(event).toMatchObject({ kind: "message", at: 1000, place: { kind: "dm" }, person: { name: "+123" }, mentionsMe: true, files: [{ name: "x.txt" }] });
    expect(await channel.fetchFile!(event!.files![0]!, new AbortController().signal)).toEqual(Buffer.from("x"));
    const sent = await channel.send(event!.place!.address, "hello", "send-1");
    expect(sent.place).toBe(event!.place!.address);
    expect(fake.sent).toMatchObject([{ threadId: "imessage:iMessage;-;+123~+456", message: { markdown: "hello" } }]);
    await channel.stop();
  });
});
