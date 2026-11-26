import assert from "node:assert/strict";
import test from "node:test";
import { chatOutput } from "./chat-output.ts";
import { runEvents, sentId } from "./turn.mjs";

test("strips escapes and the name only at the start of each line, across split chunks", () => {
  const output = chatOutput("Oracle");
  const first = output.push("\x1b[1mOra");
  const second = output.push("cle\x1b[22m: Hello.\nSecond line says Oracle: as text\n\x1b[1mOracle\x1b[22m: Bye");
  assert.deepEqual(first, { text: "", events: [] });
  assert.deepEqual(second, { text: "Hello.\nSecond line says Oracle: as text\n", events: [] });
  assert.deepEqual(output.end(), { text: "Bye", events: [] });
});

test("event lines become events and never text", () => {
  const output = chatOutput("Oracle");
  const got = output.push('Oracle: Looking.\n\x1e{"t":"call","id":"c1","name":"bash","at":5}\nDone.\n');
  assert.deepEqual(got, { text: "Looking.\nDone.\n", events: [{ t: "call", id: "c1", name: "bash", at: 5 }] });
});

test("finds the person's message by its text, not the bot's", () => {
  const file = [
    JSON.stringify({ id: "m-bot", type: "message", person: "bot", text: "hi" }),
    JSON.stringify({ id: "m-me", type: "message", person: "vercel-sandbox", text: "hi" }),
  ].join("\n");
  assert.equal(sentId(file, "hi"), "m-me");
  assert.equal(sentId(file, "other"), undefined);
});

test("projects only allowlisted fields of a run's tool calls", () => {
  const events = runEvents([
    {
      id: 2,
      record: {
        model: [
          {
            role: "assistant",
            timestamp: 10,
            content: [
              { type: "text", text: "private reasoning" },
              { type: "toolCall", id: "a", name: "bash", arguments: { command: "cat secrets.env" } },
              { type: "toolCall", id: "b", name: "task", arguments: { action: "start", title: "Research", brief: "private brief", model: "openai/gpt" } },
            ],
          },
        ],
      },
    },
    { id: 3, record: { model: [{ role: "toolResult", toolCallId: "a", toolName: "bash", isError: true, timestamp: 12, durationMs: 2, content: [{ type: "text", text: "SECRET=1" }] }] } },
  ]);
  assert.deepEqual(events, [
    { t: "call", id: "a", name: "bash", at: 10 },
    { t: "call", id: "b", name: "task", at: 10, title: "Research", model: "openai/gpt" },
    { t: "result", id: "a", at: 12, error: true, ms: 2 },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /secrets|SECRET|private/);
});
