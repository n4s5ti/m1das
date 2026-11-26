// turn.mjs passes pots chat's output through, which prints the bot's lines as "<Name>: <text>" (with ANSI bold/dim
// when it thinks it may), and adds event lines that start with \x1e for the tool calls of the bot's run.
// The browser gets the text without escapes and name prefix, and the events as data.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const EVENT = "\x1e";

/** A tool call of the bot's run, with only the fields turn.mjs lets out of the sandbox. */
export type TurnEvent =
  | { t: "call"; id: string; name: string; at?: number; title?: string; model?: string }
  | { t: "result"; id: string; at?: number; error: boolean; ms?: number };

export type TurnOutput = { text: string; events: TurnEvent[] };

/** Turns turn.mjs stdout, arriving in arbitrary pieces, into text and events, one complete line at a time. */
export function chatOutput(name: string): { push(chunk: string): TurnOutput; end(): TurnOutput } {
  const prefix = `${name}: `;
  let pending = "";
  const take = (lines: string[], last: boolean): TurnOutput => {
    let text = "";
    const events: TurnEvent[] = [];
    lines.forEach((line, index) => {
      if (line.startsWith(EVENT)) {
        try {
          events.push(JSON.parse(line.slice(1)) as TurnEvent);
        } catch {
          // Not an event after all; never shown as text either.
        }
        return;
      }
      const plain = line.replace(ANSI, "");
      text += (plain.startsWith(prefix) ? plain.slice(prefix.length) : plain) + (last && index === lines.length - 1 ? "" : "\n");
    });
    return { text, events };
  };
  return {
    push(chunk) {
      pending += chunk;
      const end = pending.lastIndexOf("\n");
      if (end === -1) return { text: "", events: [] };
      const lines = pending.slice(0, end).split("\n");
      pending = pending.slice(end + 1);
      return take(lines, false);
    },
    end() {
      const rest = pending;
      pending = "";
      return rest ? take([rest], true) : { text: "", events: [] };
    },
  };
}
