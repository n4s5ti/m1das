import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { chatOutput } from "../chat-output.js";
import { lookup, NAME } from "../sandbox.js";

// pots chat waits this long for the answer. With the lock wait below, a turn ends before the
// function's 800-second limit in vercel.json, so no message is sent after its request is gone.
const ANSWER_TIMEOUT_SECONDS = 700;
const LOCK_WAIT_SECONDS = 30;
const BUSY = 75;

// One turn at a time: pots chat keeps one read cursor for the terminal channel, so two turns at once
// would each print the other's answer. A turn waits a bounded time for the one before it, then gives
// up without sending. The message is "$1", never part of the script.
const TURN = `export PATH="$HOME/.local/bin:$PATH"; exec flock -w ${LOCK_WAIT_SECONDS} -E ${BUSY} "$HOME/oracle-web-chat.lock" pots chat --bot oracle --timeout "$2" -m "$1"`;

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
      const command = await existing.sandbox.runCommand({
        cmd: "sh",
        args: ["-c", TURN, "sh", text, String(ANSWER_TIMEOUT_SECONDS)],
        env: { NO_COLOR: "1" },
        detached: true,
      });
      const stopped = () => void command.kill().catch(() => {});
      request.signal.addEventListener("abort", stopped, { once: true });

      const id = "oracle";
      const output = chatOutput("Oracle");
      let errors = "";
      writer.write({ type: "text-start", id });
      for await (const log of command.logs({ signal: request.signal })) {
        if (log.stream === "stderr") {
          errors += log.data;
          continue;
        }
        const delta = output.push(log.data);
        if (delta) writer.write({ type: "text-delta", id, delta });
      }
      const rest = output.end();
      if (rest) writer.write({ type: "text-delta", id, delta: rest });
      writer.write({ type: "text-end", id });
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
