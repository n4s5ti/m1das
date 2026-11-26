// Runs in the Oracle sandbox for one chat turn from the web page: sends the message with `pots chat`, passes its
// output through line by line, and adds the tool calls of the bot's run for this message as event lines.
//
// The run is found by the message's own ID: pots chat appends the message to the terminal channel's file, the gateway
// wakes the bot with a wake whose text names that ID, and the run is every entry after that wake up to the next one.
// Only allowlisted fields leave the sandbox: a tool's name, its call ID, when it ran, whether it failed, and for the
// task tool's start the child's title and model. No arguments, results or model text of other conversations.
//
// Usage: node turn.mjs <cli> <bot> <message> <timeout seconds>

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Marks an event line on stdout; never in pots chat's own output. */
export const EVENT = "\x1e";

/** The ID of the message with this text that the person (not the bot) added to the terminal file after `offset`. */
export function sentId(fileText, text) {
  for (const raw of fileText.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw);
      if (line.type === "message" && line.person !== "bot" && line.text === text) return line.id;
    } catch {
      // A line still being written.
    }
  }
  return undefined;
}

const shortText = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

/** The allowlisted events of a run's entries (each `{ id, record }`), in order. */
export function runEvents(entries) {
  const events = [];
  for (const { record } of entries) {
    for (const message of record.model ?? []) {
      if (message.role === "assistant") {
        for (const part of message.content ?? []) {
          if (part.type !== "toolCall") continue;
          const start = part.name === "task" && part.arguments?.action === "start";
          events.push({
            t: "call",
            id: String(part.id),
            name: String(part.name),
            at: message.timestamp,
            ...(start ? { title: shortText(part.arguments.title, 120), model: shortText(part.arguments.model, 80) } : {}),
          });
        }
      } else if (message.role === "toolResult") {
        events.push({ t: "result", id: String(message.toolCallId), at: message.timestamp, error: message.isError === true, ms: message.durationMs });
      }
    }
  }
  return events;
}

async function main() {
  const [cli, bot, text, timeout] = process.argv.slice(2);
  const dir = `${process.env.HOME}/.pots/bots/${bot}`;
  const terminal = `${dir}/terminal/platform.jsonl`;
  const from = existsSync(terminal) ? statSync(terminal).size : 0;

  // Whole lines only, so an event line never lands inside a line of pots chat's output.
  let pending = "";
  const child = spawn(cli, ["chat", "--bot", bot, "--timeout", timeout, "-m", text], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const end = pending.lastIndexOf("\n");
    if (end === -1) return;
    process.stdout.write(pending.slice(0, end + 1));
    pending = pending.slice(end + 1);
  });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));

  const { DatabaseSync } = await import("node:sqlite");
  let db;
  let failed = false;
  let messageId;
  let wake;
  const shown = new Set();
  const poll = () => {
    try {
      if (!messageId && existsSync(terminal)) messageId = sentId(readFileSync(terminal).subarray(from).toString("utf8"), text);
      if (!messageId || !existsSync(`${dir}/bot.sqlite`)) return;
      db ??= new DatabaseSync(`${dir}/bot.sqlite`, { readOnly: true });
      wake ??= db
        .prepare("SELECT id, conversation_id AS conversation FROM pi_entries WHERE json_extract(record, '$.kind') = 'bot.wake' AND instr(record, ?) > 0 ORDER BY id LIMIT 1")
        .get(`/${messageId}`);
      if (!wake) return;
      const next = db
        .prepare("SELECT min(id) AS id FROM pi_entries WHERE conversation_id = ? AND id > ? AND json_extract(record, '$.kind') = 'bot.wake'")
        .get(wake.conversation, wake.id)?.id;
      const rows = db
        .prepare("SELECT id, record FROM pi_entries WHERE conversation_id = ? AND id > ? AND id < ? ORDER BY id")
        .all(wake.conversation, wake.id, next ?? Number.MAX_SAFE_INTEGER);
      for (const event of runEvents(rows.map((row) => ({ id: row.id, record: JSON.parse(row.record) })))) {
        const key = `${event.t}:${event.id}`;
        if (shown.has(key)) continue;
        shown.add(key);
        process.stdout.write(`${EVENT}${JSON.stringify(event)}\n`);
      }
    } catch (error) {
      // The answer still comes without the tool calls; say why once.
      if (!failed) process.stderr.write(`oracle-turn: tool events unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      failed = true;
    }
  };

  const timer = setInterval(poll, 700);
  const code = await exited;
  clearInterval(timer);
  poll();
  if (pending) process.stdout.write(pending);
  db?.close();
  process.exit(code);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
