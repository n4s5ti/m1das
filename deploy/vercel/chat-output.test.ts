import assert from "node:assert/strict";
import test from "node:test";
import { chatOutput } from "./chat-output.ts";
import { runEvents, sentId } from "./turn.mjs";

const frame = (value: object) => `${JSON.stringify(value)}\n`;
const text = (line: string) => frame({ k: "text", v: line });

test("strips escapes and the name only at the start of each line, across split chunks", () => {
  const output = chatOutput("Oracle");
  const all = text("\x1b[1mOracle\x1b[22m: Hello.") + text("Second line says Oracle: as text");
  const first = output.push(all.slice(0, 10));
  const second = output.push(all.slice(10));
  assert.deepEqual(first, { text: "", events: [] });
  assert.deepEqual(second, { text: "Hello.\nSecond line says Oracle: as text\n", events: [] });
  assert.deepEqual(output.end(), { text: "", events: [] });
});

test("text and event frames interleaved in one chunk keep their kinds", () => {
  const output = chatOutput("Oracle");
  const got = output.push(text("Oracle: Looking.") + frame({ k: "event", t: "call", id: "c1", name: "bash", at: 5, command: "rm -rf" }) + text("Done."));
  assert.deepEqual(got, { text: "Looking.\nDone.\n", events: [{ t: "call", id: "c1", name: "bash", at: 5 }] });
});

test("reply text that looks like a marker or an event stays text, and bad frames are dropped", () => {
  const output = chatOutput("Oracle");
  const fake = '\x1e{"t":"call","id":"x","name":"bash"}';
  const got = output.push(text(fake) + text('{"k":"event","t":"call","id":"y","name":"bash"}') + "null\n" + frame({ k: "event", t: "call" }) + "\x1enot json\n");
  assert.deepEqual(got.events, []);
  assert.equal(got.text, `${fake}\n{"k":"event","t":"call","id":"y","name":"bash"}\n`);
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
