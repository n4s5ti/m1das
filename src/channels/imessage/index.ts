import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createiMessageAdapter, type iMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import type { ChatInstance } from "chat";
import type { Address, ChannelAdapter, ChannelConfig, ChannelEnv, ChannelSink, FileInfo, Happening, PersonInfo, SentMessage } from "../../core/channel.ts";
import { expandHome, readSecrets } from "../../core/env-file.ts";

// The encoded SDK thread ID includes the sending line. Encode each address component so GUIDs and handles stay opaque.
// place: <id>:#<encoded SDK thread ID>; message: <place>/<encoded message ID>; person: <id>:@<encoded handle>.
type Event = { kind: "message" | "reaction_added" | "reaction_removed"; at: number; threadId: string; messageId: string; person?: string; text: string; files?: FileInfo[]; fromMe: boolean; sendId?: string; replyTo?: string };

export function createChannel(config: ChannelConfig, _env: ChannelEnv): ChannelAdapter {
  if (typeof config.secrets !== "string") throw new Error(`channel ${config.id}: "secrets" must name the env file with IMESSAGE_PROJECT_ID and IMESSAGE_PROJECT_SECRET`);
  return new IMessageChannel(config.id, expandHome(config.secrets));
}

class IMessageChannel implements ChannelAdapter {
  readonly me = undefined;
  #sdk?: iMessageAdapter;
  #stopping = false;
  #listener?: Promise<void>;
  readonly #files = new Map<string, () => Promise<Buffer>>();
  #sink?: ChannelSink;
  readonly id: string;
  readonly secrets: string;
  constructor(id: string, secrets: string) {
    this.id = id;
    this.secrets = secrets;
  }

  async start(sink: ChannelSink): Promise<void> {
    const secrets = readSecrets(this.secrets, ["IMESSAGE_PROJECT_ID", "IMESSAGE_PROJECT_SECRET"]);
    const sdk = createiMessageAdapter({ projectId: secrets.IMESSAGE_PROJECT_ID!, projectSecret: secrets.IMESSAGE_PROJECT_SECRET! });
    this.#sdk = sdk;
    this.#sink = sink;
    await sdk.initialize({} as ChatInstance);
    const app = sdk.app!;
    // Consume Spectrum's stream directly: unlike the Chat SDK callback it lets us await inbox storage.
    // Its cursor is in memory, not persisted, and it exposes no history after a process restart.
    this.#listener = (async () => {
      try {
        for await (const [space, message] of app.messages) {
          if (this.#stopping) break;
          if (message.direction === "outbound") continue;
          const line = "phone" in space && typeof space.phone === "string" ? space.phone : undefined;
          const threadId = sdk.encodeThreadId({ chatGuid: space.id, ...(line ? { phone: line } : {}) });
          const content = message.content;
          if (["addMember", "removeMember", "leaveSpace", "rename", "avatar", "typing", "read", "poll_option"].includes(content.type)) continue;
          const parsed = sdk.parseMessage(message);
          const target = content.type === "reply" ? content.target : undefined;
          const reaction = content.type === "reaction" ? content : undefined;
          const files: FileInfo[] = [];
          const collect = (item: typeof content): void => {
            if (item.type === "attachment" || item.type === "voice") {
              const url = `imessage-file:${encodeURIComponent(threadId)}:${encodeURIComponent(message.id)}:${files.length}`;
              this.#files.set(url, item.read);
              if (this.#files.size > 5000) this.#files.delete(this.#files.keys().next().value!);
              files.push({ url, ...(item.name ? { name: item.name } : {}), ...(item.mimeType ? { type: item.mimeType } : {}), ...(item.size !== undefined ? { size: item.size } : {}) });
            } else if (item.type === "reply") collect(item.content);
            else if (item.type === "group") for (const part of item.items) collect(part.content);
          };
          collect(content);
          const event: Event = {
            kind: reaction ? "reaction_added" : "message", at: message.timestamp.getTime(), threadId,
            messageId: reaction ? reaction.target.id : message.id,
            person: message.sender?.id, text: reaction ? reaction.emoji : parsed.text,
            files, fromMe: false, replyTo: target?.id,
          };
          // Keep the current event until it is stored; advancing would discard it on a transient inbox failure.
          while (!this.#stopping) {
            try { await sink.receive(`${reaction ? "reaction" : "message"}:${threadId}:${message.id}`, event); break; }
            catch (error) {
              sink.log("iMessage event not stored; retrying", { error: error instanceof Error ? error.message : String(error) });
              await wait(1000);
            }
          }
        }
      } catch (error) {
        if (!this.#stopping) sink.log("iMessage stream stopped", { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }

  async stop(): Promise<void> { this.#stopping = true; await this.#sdk?.app?.stop(); await this.#listener; }
  // Photon exposes no message history, so there is no backfill after a disconnect.
  async backfill(): Promise<void> {}
  owns(address: Address): boolean { return address.startsWith(`${this.id}:`); }
  #place(threadId: string): string { return `${this.id}:#${encodeURIComponent(threadId)}`; }
  #message(threadId: string, messageId: string): string { return `${this.#place(threadId)}/${encodeURIComponent(messageId)}`; }
  #person(person: string): string { return `${this.id}:@${encodeURIComponent(person)}`; }
  #parse(address: string): { threadId?: string; messageId?: string; person?: string } {
    if (!this.owns(address)) throw new Error(`not a ${this.id} address: ${address}`);
    const rest = address.slice(this.id.length + 1);
    if (rest.startsWith("@") && rest.length > 1) return { person: decodeURIComponent(rest.slice(1)) };
    const match = /^#([^/]+)(?:\/([^/]+))?$/.exec(rest);
    if (!match) throw new Error(`bad ${this.id} address: ${address}`);
    return { threadId: decodeURIComponent(match[1]!), ...(match[2] ? { messageId: decodeURIComponent(match[2]) } : {}) };
  }
  placeOf(address: Address): Address | undefined { const { threadId } = this.#parse(address); return threadId ? this.#place(threadId) : undefined; }
  async translate(value: unknown): Promise<Happening[]> {
    const event = value as Event;
    const sdk = this.#sdk;
    if (!sdk) throw new Error(`channel ${this.id} is not started`);
    const thread = event.replyTo ? this.#message(event.threadId, event.replyTo) : undefined;
    const person: PersonInfo | undefined = event.person ? { address: this.#person(event.person), name: event.person } : undefined;
    return [{ kind: event.kind, at: event.at, place: { address: this.#place(event.threadId), kind: sdk.isDM(event.threadId) ? "dm" : "group" }, message: this.#message(event.threadId, event.messageId), ...(thread ? { thread, threadRoot: thread } : {}), ...(person ? { person } : {}), fromMe: event.fromMe, mentionsMe: sdk.isDM(event.threadId), text: event.text, ...(event.files?.length ? { files: event.files } : {}), ...(event.sendId ? { sendId: event.sendId } : {}), raw: event }];
  }
  #adapter(): iMessageAdapter { if (!this.#sdk) throw new Error(`channel ${this.id} is not started`); return this.#sdk; }
  async send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    const sdk = this.#adapter();
    const target = this.#parse(to);
    const threadId = target.person ? await sdk.openDM(target.person) : target.threadId!;
    let messageId: string;
    if (target.messageId) {
      const original = await sdk.fetchMessage(threadId, target.messageId);
      const raw = original?.raw;
      if (!raw || typeof raw !== "object" || !("reply" in raw) || typeof raw.reply !== "function") {
        throw new Error(`iMessage cannot find ${to} to reply to it`);
      }
      const sent: unknown = await raw.reply(text);
      if (!sent || typeof sent !== "object" || !("id" in sent) || typeof sent.id !== "string") throw new Error("iMessage did not return a reply ID");
      messageId = sent.id;
    } else {
      messageId = (await sdk.postMessage(threadId, { markdown: text })).id;
    }
    const raw: Event = { kind: "message", at: Date.now(), threadId, messageId, text, fromMe: true, sendId, replyTo: target.messageId };
    return { message: this.#message(threadId, messageId), place: this.#place(threadId), raw };
  }
  async findSent(): Promise<undefined> { return undefined; }
  async react(message: Address, emoji: string, remove: boolean): Promise<void> {
    const target = this.#parse(message);
    if (!target.threadId || !target.messageId) throw new Error("iMessage reactions require a message address");
    const sdk = this.#adapter();
    if (remove) await sdk.removeReaction(target.threadId, target.messageId, emoji);
    else await sdk.addReaction(target.threadId, target.messageId, emoji);
  }
  async fetchFile(file: FileInfo, _signal: AbortSignal): Promise<Uint8Array> {
    const read = file.url && this.#files.get(file.url);
    if (!read) throw new Error("iMessage attachment is unavailable after the listener session ends");
    return read();
  }
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== "sendFile") throw new Error(`iMessage call ${method} is not supported`);
    if (typeof params.to !== "string" || typeof params.path !== "string") throw new Error("iMessage sendFile requires to and path strings");
    const target = this.#parse(params.to);
    if (target.messageId) throw new Error("iMessage file replies are not supported; send to the place instead");
    const sdk = this.#adapter();
    const threadId = target.person ? await sdk.openDM(target.person) : target.threadId!;
    const sent = await sdk.postMessage(threadId, { raw: "", files: [{ data: await readFile(params.path), filename: basename(params.path) }] });
    const raw: Event = { kind: "message", at: Date.now(), threadId, messageId: sent.id, text: "", fromMe: true };
    await this.#sink?.receive(`message:${threadId}:${sent.id}`, raw);
    return { message: this.#message(threadId, sent.id), place: this.#place(threadId) };
  }
}
