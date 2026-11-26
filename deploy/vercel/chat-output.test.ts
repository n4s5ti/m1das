import assert from "node:assert/strict";
import test from "node:test";
import { chatOutput } from "./chat-output.ts";

test("strips escapes and the name only at the start of each line, across split chunks", () => {
  const output = chatOutput("Oracle");
  let shown = output.push("\x1b[1mOra");
  shown += output.push("cle\x1b[22m: Hello.\nSecond line says Oracle: as text\n\x1b[1mOracle\x1b[22m: Bye");
  assert.equal(shown, "Hello.\nSecond line says Oracle: as text\n");
  assert.equal(output.end(), "Bye");
});

test("keeps lines that do not start with the name", () => {
  const output = chatOutput("Oracle");
  assert.equal(output.push("plain\n"), "plain\n");
  assert.equal(output.end(), "");
});
