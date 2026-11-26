import { readFileSync } from "node:fs";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage, type UIMessageStreamWriter } from "ai";
import { chatOutput, type TurnOutput } from "../chat-output.js";
import { lookup, NAME } from "../sandbox.js";

// The script that runs the turn in the sandbox and reports its tool calls; written there for each turn.
const SCRIPT = readFileSync(new URL("../turn.mjs", import.meta.url), "utf8");
const SCRIPT_PATH = "/tmp/oracle-turn.mjs";

// pots chat waits this long for the answer. With the lock wait below, a turn ends before the
// function's 800-second limit in vercel.json, so no message is sent after its request is gone.
const ANSWER_TIMEOUT_SECONDS = 700;
const LOCK_WAIT_SECONDS = 30;
const BUSY = 75;

// One turn at a time: pots chat keeps one read cursor for the terminal channel, so two turns at once
// would each print the other's answer. A turn waits a bounded time for the one before it, then gives
// up without sending. The message is "$1", never part of the script.
const TURN = `export PATH="$HOME/.local/bin:$PATH"; exec flock -w ${LOCK_WAIT_SECONDS} -E ${BUSY} "$HOME/oracle-web-chat.lock" node ${SCRIPT_PATH} pots oracle "$1" "$2"`;

/** Writes text and tool calls in the order they came: text between tool calls is its own part. */
function parts(out: UIMessageStreamWriter) {
  let part = 0;
  let open = false;
  const closeText = () => {
    if (open) out.write({ type: "text-end", id: `text-${part}` });
    open = false;
  };
  return {
    write(output: TurnOutput) {
      for (const event of output.events) {
        closeText();
        if (event.t === "call") {
          const input = { ...(event.at ? { at: event.at } : {}), ...(event.title ? { title: event.title } : {}), ...(event.model ? { model: event.model } : {}) };
          out.write({ type: "tool-input-available", toolCallId: event.id, toolName: event.name, input, dynamic: true });
        } else if (event.error) {
          out.write({ type: "tool-output-error", toolCallId: event.id, errorText: "The tool call failed", dynamic: true });
        } else {
          out.write({ type: "tool-output-available", toolCallId: event.id, output: { at: event.at, ms: event.ms }, dynamic: true });
        }
      }
      if (!output.text) return;
      if (!open) out.write({ type: "text-start", id: `text-${++part}` });
      open = true;
      out.write({ type: "text-delta", id: `text-${part}`, delta: output.text });
    },
    end: closeText,
  };
}

function lastUserText(messages: UIMessage[]): string {
  const last = messages.findLast((message) => message.role === "user");
  return (last?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

export async function POST(request: Request): Promise<Response> {
  const { messages } = (await request.json()) as { messages?: UIMessage[] };
  const text = lastUserText(messages ?? []);
  if (!text) return Response.json({ error: "Send a message with text" }, { status: 400 });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // The chat never creates, resumes or rotates the sandbox: that is the cron's job.
      const existing = await lookup(NAME);
      if (!existing || existing.status !== "running") throw new Error(`Oracle's sandbox is ${existing?.status ?? "missing"}; it is not running`);
      await existing.sandbox.writeFiles([{ path: SCRIPT_PATH, content: SCRIPT }]);
      const command = await existing.sandbox.runCommand({
        cmd: "sh",
        args: ["-c", TURN, "sh", text, String(ANSWER_TIMEOUT_SECONDS)],
        env: { NO_COLOR: "1" },
        detached: true,
      });
      const stopped = () => void command.kill().catch(() => {});
      request.signal.addEventListener("abort", stopped, { once: true });

      const output = chatOutput("Oracle");
      const message = parts(writer);
      let errors = "";
      for await (const log of command.logs({ signal: request.signal })) {
        if (log.stream === "stderr") {
          errors += log.data;
          continue;
        }
        message.write(output.push(log.data));
      }
      message.write(output.end());
      message.end();
      request.signal.removeEventListener("abort", stopped);

      const finished = await command.wait();
      if (finished.exitCode === BUSY) throw new Error("Oracle is still answering an earlier message; send this again when it is done");
      if (finished.exitCode !== 0) throw new Error(errors.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim() || `pots chat exited with ${finished.exitCode}`);
    },
    onError: (error) => {
      console.error("Oracle chat failed", error);
      return error instanceof Error ? error.message : "Oracle chat failed; see function logs";
    },
  });
  return createUIMessageStreamResponse({ stream });
}
