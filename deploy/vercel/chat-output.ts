// turn.mjs writes one JSON frame per line: {"k":"text","v":<a line of pots chat's output>} or {"k":"event",...} for a
// tool call of the bot's run. pots chat prints the bot's lines as "<Name>: <text>", with ANSI bold/dim when it thinks
// it may. The browser gets the text without escapes and name prefix, and the events as validated data. A line that is
// not a valid frame is dropped: nothing the bot writes reaches the browser except as text.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** A tool call of the bot's run, with only the fields turn.mjs lets out of the sandbox. */
export type TurnEvent =
  | { t: "call"; id: string; name: string; at?: number; title?: string; model?: string }
  | { t: "result"; id: string; at?: number; error: boolean; ms?: number };

export type TurnOutput = { text: string; events: TurnEvent[] };

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const short = (value: unknown, max: number) => (typeof value === "string" && value ? value.slice(0, max) : undefined);

/** The event in a frame, with only known fields of the right types, or undefined. */
export function turnEvent(frame: Record<string, unknown>): TurnEvent | undefined {
  const id = short(frame.id, 200);
  if (!id) return undefined;
  const at = num(frame.at);
  if (frame.t === "call") {
    const name = short(frame.name, 100);
    if (!name) return undefined;
    const title = short(frame.title, 120);
    const model = short(frame.model, 80);
    return { t: "call", id, name, ...(at === undefined ? {} : { at }), ...(title ? { title } : {}), ...(model ? { model } : {}) };
  }
  if (frame.t === "result" && typeof frame.error === "boolean") {
    const ms = num(frame.ms);
    return { t: "result", id, error: frame.error, ...(at === undefined ? {} : { at }), ...(ms === undefined ? {} : { ms }) };
  }
  return undefined;
}

/** Turns turn.mjs stdout, arriving in arbitrary pieces, into text and events, one complete frame at a time. */
export function chatOutput(name: string): { push(chunk: string): TurnOutput; end(): TurnOutput } {
  const prefix = `${name}: `;
  let pending = "";
  const take = (lines: string[]): TurnOutput => {
    let text = "";
    const events: TurnEvent[] = [];
    for (const line of lines) {
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) continue;
      const record = frame as Record<string, unknown>;
      if (record.k === "text" && typeof record.v === "string") {
        const plain = record.v.replace(ANSI, "");
        text += `${plain.startsWith(prefix) ? plain.slice(prefix.length) : plain}\n`;
      } else if (record.k === "event") {
        const event = turnEvent(record);
        if (event) events.push(event);
      }
    }
    return { text, events };
  };
  return {
    push(chunk) {
      pending += chunk;
      const end = pending.lastIndexOf("\n");
      if (end === -1) return { text: "", events: [] };
      const lines = pending.slice(0, end).split("\n");
      pending = pending.slice(end + 1);
      return take(lines);
    },
    end() {
      const rest = pending;
      pending = "";
      return take(rest ? [rest] : []);
    },
  };
}
